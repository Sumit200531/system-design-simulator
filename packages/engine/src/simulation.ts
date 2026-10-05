import { CATALOG, type Routing } from "./catalog.ts";
import {
  ZERO_LATENCY,
  choice,
  meanLatency,
  meanQueueingDelaySeconds,
  percentile,
  sequence,
  shift,
  type LatencyMixture,
} from "./queueing.ts";
import type { Architecture, ComponentSpec, Traffic } from "./types.ts";
import { topologicalOrder } from "./validate.ts";

/**
 * Deterministic fluid simulation of request traffic.
 *
 * Time advances in fixed ticks. Each tick:
 *   1. a forward pass (topological order) routes traffic rates through the
 *      graph, applying capacity limits, backlogs, timeouts and failures;
 *   2. a backward pass (reverse order) composes success probabilities and
 *      latency distributions from the leaves up to the clients.
 * No randomness is used anywhere: the same design and the same actions
 * always produce the same numbers.
 */

export const DEFAULT_TICK_SECONDS = 0.1;
/** Time for a restarted instance to boot and pass its first health check. */
export const RESTART_SECONDS = 4;
/** Distinct reads a cache needs to see to fill (sets how fast a cold cache warms). */
export const CACHE_WARMUP_REQUESTS = 10_000;
/** Seconds of history kept for charts. */
export const HISTORY_SECONDS = 300;
const SATURATED = 0.95;
const RELIEVED = 0.8;
const ERROR_ALERT = 0.05;
const ERROR_CLEAR = 0.01;
const QUEUE_ALERT = 0.8;

export type ChaosAction =
  | { readonly type: "killReplica"; readonly componentId: string }
  | { readonly type: "killComponent"; readonly componentId: string }
  | { readonly type: "restartComponent"; readonly componentId: string }
  | { readonly type: "setTrafficMultiplier"; readonly multiplier: number }
  | { readonly type: "setAddedLatency"; readonly componentId: string; readonly ms: number }
  | { readonly type: "setConsumerSlowdown"; readonly componentId: string; readonly factor: number }
  | { readonly type: "recoverAll" };

export type EventSeverity = "info" | "warning" | "critical" | "recovery";

export interface SimEvent {
  readonly time: number;
  readonly severity: EventSeverity;
  readonly message: string;
  readonly componentId?: string;
}

export interface ComponentMetrics {
  readonly arrivalsPerSecond: number;
  readonly servedPerSecond: number;
  readonly failuresPerSecond: number;
  readonly utilization: number;
  /** Requests (or messages, for queues) waiting at this component. */
  readonly backlog: number;
  /** Mean latency of a request served here, including everything downstream (sync only). */
  readonly latencyMs: number;
  /** Probability a request arriving here eventually succeeds. */
  readonly successRate: number;
  readonly replicasUp: number;
  readonly replicasStarting: number;
  readonly replicasDown: number;
  /** Caches and CDNs: fraction of all requests served locally this tick. */
  readonly hitRate: number | null;
  readonly warmth: number | null;
  /** Queues: seconds a new message waits before a consumer picks it up. */
  readonly lagSeconds: number | null;
  readonly addedLatencyMs: number;
  readonly consumerSlowdown: number;
  readonly status: "healthy" | "degraded" | "saturated" | "down";
}

export interface ConnectionMetrics {
  readonly ratePerSecond: number;
  /** Probability that a request sent along this connection fails somewhere downstream. */
  readonly errorRate: number;
}

export interface GlobalMetrics {
  readonly time: number;
  readonly offeredPerSecond: number;
  readonly throughputPerSecond: number;
  readonly errorRate: number;
  readonly meanLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly queueDepth: number;
  readonly cacheHitRate: number | null;
  readonly peakUtilization: number;
  readonly bottleneckId: string | null;
  readonly asyncProcessedPerSecond: number;
}

export interface Snapshot {
  readonly time: number;
  readonly global: GlobalMetrics;
  readonly components: Readonly<Record<string, ComponentMetrics>>;
  readonly connections: Readonly<Record<string, ConnectionMetrics>>;
  readonly history: readonly GlobalMetrics[];
  readonly events: readonly SimEvent[];
  readonly trafficMultiplier: number;
}

type ReplicaStatus = "up" | "down" | "starting";
interface Replica {
  status: ReplicaStatus;
  changedAt: number;
}

const ZERO: Traffic = { reads: 0, writes: 0 };
const add = (a: Traffic, b: Traffic): Traffic => ({ reads: a.reads + b.reads, writes: a.writes + b.writes });
const scale = (a: Traffic, k: number): Traffic => ({ reads: a.reads * k, writes: a.writes * k });
const total = (a: Traffic) => a.reads + a.writes;

/** Per-component state that persists across ticks, plus scratch values for the current tick. */
class Runtime {
  replicas: Replica[];
  backlog: Traffic = ZERO;
  warmth = 1;
  queueDepth = 0;
  redelivered = 0;
  addedLatencyMs = 0;
  consumerSlowdown = 1;
  // Alert hysteresis.
  saturatedAlert = false;
  downAlert = false;
  queueAlert = false;
  removedFromRotation = 0;

  // Scratch, reset every tick.
  arrivals: Traffic = ZERO;
  served: Traffic = ZERO;
  failures = 0;
  hits = 0;
  utilization = 0;
  waitMs = 0;
  backlogMs = 0;
  bypass = false;
  forwarded = new Map<string, Traffic>();
  success = 1;
  latency: LatencyMixture = ZERO_LATENCY;
  delivered = 0;
  lagSeconds = 0;

  constructor(public spec: ComponentSpec, now: number) {
    this.replicas = Array.from({ length: spec.config.replicas }, () => ({ status: "up" as ReplicaStatus, changedAt: now }));
  }

  get routing(): Routing {
    return CATALOG[this.spec.kind].routing;
  }

  count(status: ReplicaStatus): number {
    return this.replicas.filter((r) => r.status === status).length;
  }

  /** Dead instances that health checks have not yet noticed still receive their share of traffic. */
  undetectedDown(now: number): number {
    return this.replicas.filter((r) => r.status === "down" && now - r.changedAt < this.spec.config.healthCheckSeconds).length;
  }

  routable(now: number): number {
    return this.count("up") + this.undetectedDown(now);
  }

  resetScratch(): void {
    this.arrivals = ZERO;
    this.served = ZERO;
    this.failures = 0;
    this.hits = 0;
    this.utilization = 0;
    this.waitMs = 0;
    this.backlogMs = 0;
    this.bypass = false;
    this.forwarded = new Map();
    this.success = 1;
    this.latency = ZERO_LATENCY;
    this.delivered = 0;
    this.lagSeconds = 0;
  }
}

export class Simulation {
  readonly tickSeconds: number;
  private time = 0;
  private architecture: Architecture;
  private order: string[] = [];
  private runtimes = new Map<string, Runtime>();
  private trafficMultiplier = 1;
  private previousFailure = new Map<string, number>();
  private readonly events: SimEvent[] = [];
  private readonly history: GlobalMetrics[] = [];
  private window: GlobalMetrics[] = [];
  private last: GlobalMetrics;
  private errorAlert = false;

  constructor(architecture: Architecture, options: { tickSeconds?: number } = {}) {
    this.tickSeconds = options.tickSeconds ?? DEFAULT_TICK_SECONDS;
    this.architecture = architecture;
    this.last = emptyGlobal(0);
    this.setArchitecture(architecture);
  }

  get now(): number {
    return this.time;
  }

  /**
   * Replace the design while keeping runtime state (backlogs, dead replicas,
   * cache warmth) for components that still exist. Lets users edit live.
   */
  setArchitecture(architecture: Architecture): void {
    const order = topologicalOrder(architecture);
    if (!order) throw new Error("Architecture contains a cycle");
    const next = new Map<string, Runtime>();
    for (const spec of architecture.components) {
      const existing = this.runtimes.get(spec.id);
      if (!existing) {
        next.set(spec.id, new Runtime(spec, this.time));
        continue;
      }
      existing.spec = spec;
      const want = spec.config.replicas;
      if (existing.replicas.length > want) existing.replicas.length = want;
      while (existing.replicas.length < want) existing.replicas.push({ status: "starting", changedAt: this.time });
      next.set(spec.id, existing);
    }
    this.runtimes = next;
    this.order = order;
    this.architecture = architecture;
  }

  apply(action: ChaosAction): void {
    const runtime = "componentId" in action ? this.runtimes.get(action.componentId) : undefined;
    const name = runtime?.spec.label ?? "";
    switch (action.type) {
      case "killReplica": {
        const victim = runtime?.replicas.find((r) => r.status === "up");
        if (!runtime || !victim) return;
        victim.status = "down";
        victim.changedAt = this.time;
        this.log("critical", `${name}: one instance crashed (${runtime.count("up")} of ${runtime.replicas.length} left)`, runtime.spec.id);
        break;
      }
      case "killComponent": {
        if (!runtime) return;
        for (const r of runtime.replicas) if (r.status !== "down") Object.assign(r, { status: "down", changedAt: this.time });
        if (runtime.spec.kind === "cache" || runtime.spec.kind === "cdn") runtime.warmth = 0;
        this.log("critical", `${name}: all instances down`, runtime.spec.id);
        break;
      }
      case "restartComponent": {
        if (!runtime) return;
        let restarted = 0;
        for (const r of runtime.replicas) {
          if (r.status === "down") {
            Object.assign(r, { status: "starting", changedAt: this.time });
            restarted += 1;
          }
        }
        if (restarted > 0) this.log("info", `${name}: restarting ${restarted} instance${restarted > 1 ? "s" : ""}`, runtime.spec.id);
        break;
      }
      case "setTrafficMultiplier":
        if (action.multiplier === this.trafficMultiplier) return;
        this.log(action.multiplier > 1 ? "warning" : "recovery", action.multiplier > 1 ? `Traffic spike: ${action.multiplier}× normal load` : "Traffic back to normal");
        this.trafficMultiplier = action.multiplier;
        break;
      case "setAddedLatency":
        if (!runtime || runtime.addedLatencyMs === action.ms) return;
        runtime.addedLatencyMs = action.ms;
        this.log(action.ms > 0 ? "warning" : "recovery", action.ms > 0 ? `${name}: network latency +${action.ms} ms` : `${name}: network latency restored`, runtime.spec.id);
        break;
      case "setConsumerSlowdown":
        if (!runtime || runtime.consumerSlowdown === action.factor) return;
        runtime.consumerSlowdown = action.factor;
        this.log(
          action.factor < 1 ? "warning" : "recovery",
          action.factor < 1 ? `${name}: processing slowed to ${Math.round(action.factor * 100)}% speed` : `${name}: processing speed restored`,
          runtime.spec.id,
        );
        break;
      case "recoverAll":
        this.apply({ type: "setTrafficMultiplier", multiplier: 1 });
        for (const r of this.runtimes.values()) {
          this.apply({ type: "restartComponent", componentId: r.spec.id });
          this.apply({ type: "setAddedLatency", componentId: r.spec.id, ms: 0 });
          this.apply({ type: "setConsumerSlowdown", componentId: r.spec.id, factor: 1 });
        }
        break;
    }
  }

  /** Advance one tick. */
  step(): void {
    const dt = this.tickSeconds;
    this.time = round(this.time + dt);
    this.updateReplicas();
    for (const runtime of this.runtimes.values()) {
      const redelivered = runtime.redelivered;
      runtime.resetScratch();
      runtime.redelivered = redelivered;
    }
    for (const id of this.order) this.forward(this.runtimes.get(id)!, dt);
    for (const id of [...this.order].reverse()) this.backward(this.runtimes.get(id)!);
    this.collect();
  }

  /** Advance by a duration, in whole ticks. */
  advance(seconds: number): void {
    const ticks = Math.round(seconds / this.tickSeconds);
    for (let i = 0; i < ticks; i++) this.step();
  }

  snapshot(): Snapshot {
    const components: Record<string, ComponentMetrics> = {};
    for (const r of this.runtimes.values()) components[r.spec.id] = this.componentMetrics(r);
    const connections: Record<string, ConnectionMetrics> = {};
    for (const c of this.architecture.connections) {
      const source = this.runtimes.get(c.source);
      const target = this.runtimes.get(c.target);
      if (!source || !target) continue;
      connections[c.id] = { ratePerSecond: total(source.forwarded.get(c.target) ?? ZERO), errorRate: clamp01(1 - target.success) };
    }
    return {
      time: this.time,
      global: this.last,
      components,
      connections,
      history: this.history,
      events: this.events,
      trafficMultiplier: this.trafficMultiplier,
    };
  }

  // ── Tick internals ───────────────────────────────────────────────────

  private updateReplicas(): void {
    for (const runtime of this.runtimes.values()) {
      let booted = 0;
      for (const replica of runtime.replicas) {
        if (replica.status === "starting" && this.time - replica.changedAt >= RESTART_SECONDS - 1e-9) {
          replica.status = "up";
          replica.changedAt = this.time;
          booted += 1;
        }
      }
      if (booted > 0) {
        if (runtime.spec.kind === "cache" || runtime.spec.kind === "cdn") {
          if (runtime.count("up") === booted) runtime.warmth = 0; // came back empty
          this.log("recovery", `${runtime.spec.label}: ${booted} instance${booted > 1 ? "s" : ""} back${runtime.warmth < 0.5 ? " with a cold cache" : ""}`, runtime.spec.id);
        } else {
          this.log("recovery", `${runtime.spec.label}: ${booted} instance${booted > 1 ? "s" : ""} back in rotation`, runtime.spec.id);
        }
      }
      // Health checks catch up with crashed instances.
      const removed = runtime.count("down") - runtime.undetectedDown(this.time);
      if (removed > runtime.removedFromRotation) {
        this.log("warning", `${runtime.spec.label}: health check removed ${removed - runtime.removedFromRotation} dead instance${removed - runtime.removedFromRotation > 1 ? "s" : ""} from rotation`, runtime.spec.id);
      }
      runtime.removedFromRotation = removed;
    }
  }

  private downstream(runtime: Runtime): Runtime[] {
    return this.architecture.connections.filter((c) => c.source === runtime.spec.id).map((c) => this.runtimes.get(c.target)!).filter(Boolean);
  }

  private send(from: Runtime, to: Runtime, traffic: Traffic): void {
    from.forwarded.set(to.spec.id, add(from.forwarded.get(to.spec.id) ?? ZERO, traffic));
    to.arrivals = add(to.arrivals, traffic);
  }

  private forward(r: Runtime, dt: number): void {
    const config = r.spec.config;
    if (r.spec.kind === "client") {
      const base = (config.requestsPerSecond ?? 0) * this.trafficMultiplier;
      const f = this.previousFailure.get(r.spec.id) ?? 0;
      let amplification = 1;
      for (let i = 1; i <= (config.retries ?? 0); i++) amplification += Math.pow(f, i);
      const offered = base * amplification;
      const writes = offered * (config.writeRatio ?? 0);
      r.arrivals = { reads: offered - writes, writes };
    }
    const arrivals = r.arrivals;
    const up = r.count("up");
    const routable = r.routable(this.time);
    const targets = this.downstream(r);

    // Caches and CDNs fail open: when down, clients go straight to the origin.
    if ((r.spec.kind === "cache" || r.spec.kind === "cdn") && up === 0) {
      r.bypass = true;
      r.served = arrivals;
      this.distribute(r, arrivals, targets);
      return;
    }
    if (routable === 0) {
      r.failures = total(arrivals); // connection refused, fails fast
      r.backlog = ZERO;
      r.queueDepth = 0;
      return;
    }
    const deadShare = (routable - up) / routable;
    r.failures += total(arrivals) * deadShare;
    const incoming = scale(arrivals, 1 - deadShare);

    if (r.routing === "async") {
      this.forwardQueue(r, incoming, targets, dt);
      return;
    }

    // Clients are the load source, never a bottleneck (and Infinity does not survive JSON).
    const perReplica = r.spec.kind === "client" ? Number.POSITIVE_INFINITY : config.capacityPerReplica * (r.spec.kind === "worker" ? r.consumerSlowdown : 1);
    const demand = add(incoming, scale(r.backlog, 1 / dt));
    let served: Traffic;
    let capacity: Traffic;
    if (r.spec.kind === "database") {
      // Capacity is shared: writes can only use the primary; reads use whatever
      // is left across the primary and every read replica.
      const pool = perReplica * up;
      const writes = Math.min(demand.writes, perReplica);
      const reads = Math.min(demand.reads, pool - writes);
      capacity = { reads: pool, writes: perReplica };
      served = { reads, writes };
      r.utilization = Math.max((reads + writes) / pool, writes / perReplica);
    } else {
      const c = perReplica * up;
      const k = total(demand) > 0 ? Math.min(1, c / total(demand)) : 0;
      served = scale(demand, k);
      capacity = { reads: c, writes: c };
      r.utilization = Number.isFinite(c) && c > 0 ? total(served) / c : 0;
    }
    // Unserved demand waits; whatever would wait longer than the timeout is shed.
    let backlog = scale({ reads: demand.reads - served.reads, writes: demand.writes - served.writes }, dt);
    const limit = (capacityOf: number) => (Number.isFinite(capacityOf) ? capacityOf * config.timeoutSeconds : Infinity);
    const shed = {
      reads: Math.max(0, backlog.reads - limit(capacity.reads)),
      writes: Math.max(0, backlog.writes - limit(capacity.writes)),
    };
    backlog = { reads: backlog.reads - shed.reads, writes: backlog.writes - shed.writes };
    r.backlog = backlog;
    r.failures += total(shed) / dt;

    const servedTotal = total(served);
    r.failures += servedTotal * config.failureRate;
    const ok = scale(served, 1 - config.failureRate);
    r.served = served;

    const serviceTime = 1 / perReplica;
    r.waitMs = meanQueueingDelaySeconds(r.utilization, up, serviceTime) * 1000;
    const drainRate = capacity.reads;
    r.backlogMs = Number.isFinite(drainRate) && drainRate > 0 ? (total(backlog) / drainRate) * 1000 : 0;

    if (r.routing === "lookaside") {
      const hits = ok.reads * (config.hitRate ?? 0) * r.warmth;
      r.hits = hits;
      // Every read the cache sees fills it a little further.
      r.warmth += (1 - r.warmth) * (1 - Math.exp(-(ok.reads * dt) / CACHE_WARMUP_REQUESTS));
      this.distribute(r, { reads: ok.reads - hits, writes: ok.writes }, targets);
    } else if (r.routing === "fanout") {
      for (const t of targets) this.send(r, t, ok);
    } else if (r.routing === "split") {
      this.distribute(r, ok, targets);
    }
  }

  /** Load balancing: equal shares across targets that still have instances in rotation. */
  private distribute(r: Runtime, traffic: Traffic, targets: Runtime[]): void {
    if (total(traffic) <= 0) return;
    const available = targets.filter((t) => t.routable(this.time) > 0 || ((t.spec.kind === "cache" || t.spec.kind === "cdn") && t.replicas.length > 0));
    if (available.length === 0) {
      r.failures += total(traffic); // 503: nowhere to send it
      return;
    }
    for (const t of available) this.send(r, t, scale(traffic, 1 / available.length));
  }

  private forwardQueue(r: Runtime, incoming: Traffic, consumers: Runtime[], dt: number): void {
    const config = r.spec.config;
    const maxDepth = config.maxDepth ?? Infinity;
    const brokerCapacity = config.capacityPerReplica * r.count("up");
    const offered = total(incoming);
    const acceptedRate = Math.min(offered, brokerCapacity, Math.max(0, maxDepth - r.queueDepth) / dt);
    r.failures += offered - acceptedRate;
    r.utilization = brokerCapacity > 0 ? acceptedRate / brokerCapacity : 0;
    r.served = scale(incoming, offered > 0 ? acceptedRate / offered : 0);
    r.queueDepth += (acceptedRate + r.redelivered) * dt;
    r.redelivered = 0;

    const capacities = consumers.map((c) => c.spec.config.capacityPerReplica * c.consumerSlowdown * c.count("up"));
    const consumerCapacity = capacities.reduce((s, c) => s + c, 0);
    const deliverRate = Math.min(r.queueDepth / dt, consumerCapacity);
    r.queueDepth -= deliverRate * dt;
    r.delivered = deliverRate;
    consumers.forEach((consumer, i) => {
      if (consumerCapacity <= 0) return;
      const share = deliverRate * (capacities[i]! / consumerCapacity);
      // Jobs keep the read/write mix of the requests that produced them.
      const mix = offered > 0 ? incoming.writes / offered : 1;
      this.send(r, consumer, { reads: share * (1 - mix), writes: share * mix });
    });
    r.lagSeconds = deliverRate > 0 ? r.queueDepth / deliverRate : r.queueDepth > 0 ? Infinity : 0;
  }

  private backward(r: Runtime): void {
    const config = r.spec.config;
    const arrived = total(r.arrivals);
    const ownSuccess = arrived > 0 ? clamp01(1 - r.failures / arrived) : r.routable(this.time) > 0 || r.bypass ? 1 - config.failureRate : 0;
    const fixed = config.baseLatencyMs + r.addedLatencyMs + r.backlogMs;
    const own = shift(ZERO_LATENCY, r.bypass ? 1 + r.addedLatencyMs : fixed, r.bypass ? 0 : r.waitMs);
    const targets = this.downstream(r);
    const weightOf = (t: Runtime) => total(r.forwarded.get(t.spec.id) ?? ZERO);

    switch (r.routing) {
      case "terminal":
        r.success = ownSuccess;
        r.latency = own;
        break;
      case "async":
        // Producers only wait for the broker; consumer failures cause redelivery instead.
        r.success = ownSuccess;
        r.latency = own;
        for (const t of targets) r.redelivered += total(r.forwarded.get(t.spec.id) ?? ZERO) * (1 - t.success);
        break;
      case "fanout":
        r.success = ownSuccess * targets.reduce((p, t) => p * t.success, 1);
        r.latency = targets.reduce((mix, t) => sequence(mix, t.latency), own);
        break;
      case "split":
      case "lookaside": {
        const sent = targets.map((t) => ({ t, w: weightOf(t) }));
        const sentTotal = sent.reduce((s, x) => s + x.w, 0);
        const downstreamSuccess = sentTotal > 0 ? sent.reduce((s, x) => s + (x.w / sentTotal) * x.t.success, 0) : targets.length > 0 ? Math.max(...targets.map((t) => t.success)) : 0;
        const downstreamLatency = sentTotal > 0 ? choice(sent.map((x) => ({ weight: x.w, mixture: x.t.latency }))) : ZERO_LATENCY;
        if (r.routing === "split") {
          r.success = ownSuccess * downstreamSuccess;
          r.latency = sequence(own, downstreamLatency);
        } else {
          const servedTotal = total(r.served);
          const hitShare = servedTotal > 0 ? r.hits / servedTotal : 0;
          const missSuccess = targets.length > 0 ? downstreamSuccess : 0;
          r.success = ownSuccess * (hitShare + (1 - hitShare) * missSuccess);
          r.latency = choice([
            { weight: hitShare, mixture: own },
            { weight: 1 - hitShare, mixture: sequence(own, downstreamLatency) },
          ]);
        }
        break;
      }
    }
  }

  private collect(): void {
    const clients = [...this.runtimes.values()].filter((r) => r.spec.kind === "client");
    let offered = 0;
    let throughput = 0;
    const latencies: { weight: number; mixture: LatencyMixture }[] = [];
    for (const client of clients) {
      const rate = total(client.arrivals);
      offered += rate;
      throughput += rate * client.success;
      this.previousFailure.set(client.spec.id, clamp01(1 - client.success));
      latencies.push({ weight: rate * client.success, mixture: client.latency });
    }
    const mixture = choice(latencies);
    const caches = [...this.runtimes.values()].filter((r) => r.spec.kind === "cache");
    const cacheReads = caches.reduce((s, r) => s + r.arrivals.reads, 0);
    let bottleneck: Runtime | null = null;
    for (const r of this.runtimes.values()) {
      if (r.spec.kind === "client") continue;
      if (!bottleneck || r.utilization > bottleneck.utilization) bottleneck = r;
    }
    const sample: GlobalMetrics = {
      time: this.time,
      offeredPerSecond: offered,
      throughputPerSecond: throughput,
      errorRate: offered > 0 ? clamp01(1 - throughput / offered) : 0,
      meanLatencyMs: throughput > 0 ? meanLatency(mixture) : 0,
      p95LatencyMs: throughput > 0 ? percentile(mixture, 0.95) : 0,
      p99LatencyMs: throughput > 0 ? percentile(mixture, 0.99) : 0,
      queueDepth: [...this.runtimes.values()].reduce((s, r) => s + r.queueDepth, 0),
      cacheHitRate: caches.length === 0 ? null : cacheReads > 0 ? caches.reduce((s, r) => s + r.hits, 0) / cacheReads : 0,
      peakUtilization: bottleneck?.utilization ?? 0,
      bottleneckId: bottleneck && bottleneck.utilization > 0 ? bottleneck.spec.id : null,
      asyncProcessedPerSecond: [...this.runtimes.values()].reduce((s, r) => s + r.delivered, 0),
    };
    this.last = sample;
    this.window.push(sample);
    if (this.window.length >= Math.round(1 / this.tickSeconds)) {
      this.history.push(averageSamples(this.window));
      if (this.history.length > HISTORY_SECONDS) this.history.shift();
      this.window = [];
    }
    this.raiseAlerts(sample);
  }

  private raiseAlerts(sample: GlobalMetrics): void {
    for (const r of this.runtimes.values()) {
      if (r.spec.kind === "client") continue;
      const name = r.spec.label;
      if (!r.saturatedAlert && r.utilization >= SATURATED && total(r.arrivals) > 0) {
        r.saturatedAlert = true;
        this.log("warning", `${name} is saturated: requests are queueing`, r.spec.id);
      } else if (r.saturatedAlert && r.utilization < RELIEVED) {
        r.saturatedAlert = false;
        this.log("recovery", `${name} is back under capacity`, r.spec.id);
      }
      const isDown = r.routable(this.time) === 0 && r.replicas.length > 0;
      if (isDown && !r.downAlert) {
        r.downAlert = true;
        const consequence = r.spec.kind === "cache" ? "requests fall through to the database" : r.spec.kind === "cdn" ? "requests go to the origin" : "callers now fail fast";
        this.log("critical", `${name} has no healthy instances: ${consequence}`, r.spec.id);
      } else if (!isDown && r.downAlert) {
        r.downAlert = false;
      }
      const maxDepth = r.spec.config.maxDepth;
      if (r.routing === "async" && maxDepth) {
        if (!r.queueAlert && r.queueDepth >= maxDepth * QUEUE_ALERT) {
          r.queueAlert = true;
          this.log("critical", `${name} is ${Math.round((r.queueDepth / maxDepth) * 100)}% full: producers will soon be rejected`, r.spec.id);
        } else if (r.queueAlert && r.queueDepth < maxDepth * 0.5) {
          r.queueAlert = false;
          this.log("recovery", `${name} is draining`, r.spec.id);
        }
      }
    }
    if (!this.errorAlert && sample.errorRate >= ERROR_ALERT) {
      this.errorAlert = true;
      this.log("critical", `Error rate reached ${(sample.errorRate * 100).toFixed(1)}%`);
    } else if (this.errorAlert && sample.errorRate < ERROR_CLEAR) {
      this.errorAlert = false;
      this.log("recovery", "Error rate back under 1%");
    }
  }

  private componentMetrics(r: Runtime): ComponentMetrics {
    const up = r.count("up");
    const arrivals = total(r.arrivals);
    const lookaside = r.routing === "lookaside";
    const status: ComponentMetrics["status"] =
      r.replicas.length > 0 && up === 0 ? "down" : r.utilization >= SATURATED ? "saturated" : up < r.replicas.length || (arrivals > 0 && r.failures / arrivals > 0.01) ? "degraded" : "healthy";
    return {
      arrivalsPerSecond: arrivals,
      servedPerSecond: total(r.served),
      failuresPerSecond: r.failures,
      utilization: r.utilization,
      backlog: r.routing === "async" ? r.queueDepth : total(r.backlog),
      latencyMs: meanLatency(r.latency),
      successRate: r.success,
      replicasUp: up,
      replicasStarting: r.count("starting"),
      replicasDown: r.count("down"),
      hitRate: lookaside ? (total(r.served) > 0 ? r.hits / total(r.served) : 0) : null,
      warmth: lookaside ? r.warmth : null,
      lagSeconds: r.routing === "async" ? (Number.isFinite(r.lagSeconds) ? r.lagSeconds : null) : null,
      addedLatencyMs: r.addedLatencyMs,
      consumerSlowdown: r.consumerSlowdown,
      status,
    };
  }

  private log(severity: EventSeverity, message: string, componentId?: string): void {
    this.events.push({ time: this.time, severity, message, ...(componentId ? { componentId } : {}) });
    if (this.events.length > 200) this.events.shift();
  }
}

function emptyGlobal(time: number): GlobalMetrics {
  return {
    time,
    offeredPerSecond: 0,
    throughputPerSecond: 0,
    errorRate: 0,
    meanLatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    queueDepth: 0,
    cacheHitRate: null,
    peakUtilization: 0,
    bottleneckId: null,
    asyncProcessedPerSecond: 0,
  };
}

function averageSamples(samples: readonly GlobalMetrics[]): GlobalMetrics {
  const n = samples.length;
  const avg = (pick: (s: GlobalMetrics) => number) => samples.reduce((sum, s) => sum + pick(s), 0) / n;
  const last = samples[n - 1]!;
  const hits = samples.filter((s) => s.cacheHitRate !== null);
  return {
    time: last.time,
    offeredPerSecond: avg((s) => s.offeredPerSecond),
    throughputPerSecond: avg((s) => s.throughputPerSecond),
    errorRate: avg((s) => s.errorRate),
    meanLatencyMs: avg((s) => s.meanLatencyMs),
    p95LatencyMs: avg((s) => s.p95LatencyMs),
    p99LatencyMs: avg((s) => s.p99LatencyMs),
    queueDepth: last.queueDepth,
    cacheHitRate: hits.length > 0 ? hits.reduce((sum, s) => sum + s.cacheHitRate!, 0) / hits.length : null,
    peakUtilization: avg((s) => s.peakUtilization),
    bottleneckId: last.bottleneckId,
    asyncProcessedPerSecond: avg((s) => s.asyncProcessedPerSecond),
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number) => Math.round(x * 1e6) / 1e6;
