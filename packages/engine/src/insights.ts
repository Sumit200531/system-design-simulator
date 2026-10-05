import { CATALOG } from "./catalog.ts";
import type { Snapshot } from "./simulation.ts";
import type { Architecture, ComponentSpec } from "./types.ts";

/**
 * Rule-based analysis of a live simulation. Every number in a finding is
 * read from the snapshot or computed from the design; nothing is guessed.
 */

export interface Insight {
  readonly severity: "critical" | "warning" | "info" | "ok";
  readonly title: string;
  readonly detail: string;
  readonly componentId?: string;
}

/** Target utilization when sizing: leaves headroom for spikes and a failed instance. */
export const TARGET_UTILIZATION = 0.7;
const HOT = 0.85;

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${Math.round(n * 100)}%`;

function instancesNeeded(load: number, perInstance: number): number {
  return Math.max(1, Math.ceil(load / (perInstance * TARGET_UTILIZATION)));
}

export function analyze(architecture: Architecture, snapshot: Snapshot): Insight[] {
  const insights: Insight[] = [];
  const byId = new Map(architecture.components.map((c) => [c.id, c]));
  const metrics = (c: ComponentSpec) => snapshot.components[c.id];

  for (const c of architecture.components) {
    const m = metrics(c);
    if (!m || c.kind === "client") continue;
    const name = c.label;
    if (m.status === "down") {
      const effect =
        c.kind === "cache"
          ? "Every read now falls through to the database."
          : c.kind === "cdn"
            ? "Every request now goes to the origin."
            : "Everything that depends on it is failing.";
      insights.push({ severity: "critical", title: `${name} is down`, detail: `${effect} Restart it, and run more than one instance so a single crash is survivable.`, componentId: c.id });
      continue;
    }
    if (c.kind === "queue") {
      const consumers = architecture.connections.filter((x) => x.source === c.id).map((x) => byId.get(x.target)!).filter(Boolean);
      const capacity = consumers.reduce((s, w) => s + w.config.capacityPerReplica * (snapshot.components[w.id]?.replicasUp ?? 0) * (snapshot.components[w.id]?.consumerSlowdown ?? 1), 0);
      if (m.backlog > 1_000 && m.arrivalsPerSecond > capacity) {
        const perWorker = consumers[0]?.config.capacityPerReplica ?? 1;
        insights.push({
          severity: m.backlog > (c.config.maxDepth ?? Infinity) * 0.5 ? "critical" : "warning",
          title: `${name} is growing by ${fmt(m.arrivalsPerSecond - capacity)} messages/s`,
          detail: `Producers add ${fmt(m.arrivalsPerSecond)}/s but consumers can only take ${fmt(capacity)}/s. ${fmt(m.backlog)} messages are waiting${m.lagSeconds !== null ? ` (${m.lagSeconds.toFixed(0)} s of lag)` : ""}. About ${instancesNeeded(m.arrivalsPerSecond, perWorker)} workers would keep up with headroom.`,
          componentId: c.id,
        });
      }
      continue;
    }
    if (m.utilization >= HOT) {
      const load = m.arrivalsPerSecond;
      if (c.kind === "database") {
        const writeShare = estimateWriteShare(architecture);
        const writes = load * writeShare;
        if (writes >= c.config.capacityPerReplica * HOT) {
          insights.push({
            severity: "critical",
            title: `${name} is write-bound`,
            detail: `About ${fmt(writes)} writes/s reach a single primary rated for ${fmt(c.config.capacityPerReplica)}/s. Read replicas cannot help with writes. Batch writes through a queue, shard the data, or use a larger primary.`,
            componentId: c.id,
          });
          continue;
        }
        insights.push({
          severity: m.utilization >= 0.95 ? "critical" : "warning",
          title: `${name} is at ${pct(m.utilization)} utilization`,
          detail: `${fmt(load)} requests/s arrive. ${instancesNeeded(load, c.config.capacityPerReplica)} instances (primary plus read replicas) would run at ${pct(TARGET_UTILIZATION)}, or put a cache in front to absorb repeated reads.`,
          componentId: c.id,
        });
        continue;
      }
      insights.push({
        severity: m.utilization >= 0.95 ? "critical" : "warning",
        title: `${name} is the bottleneck at ${pct(m.utilization)}`,
        detail: `It receives ${fmt(load)} requests/s against ${fmt(c.config.capacityPerReplica * m.replicasUp)}/s of capacity, so requests queue${m.backlog > 1 ? ` (${fmt(m.backlog)} waiting)` : ""}. ${instancesNeeded(load, c.config.capacityPerReplica)} instances would run at ${pct(TARGET_UTILIZATION)}.`,
        componentId: c.id,
      });
    }
    if (m.warmth !== null && m.warmth < 0.8 && m.replicasUp > 0) {
      insights.push({ severity: "info", title: `${name} is warming up (${pct(m.warmth)})`, detail: "A restarted cache starts empty, so most reads miss and hit the database until it refills.", componentId: c.id });
    }
  }

  // Single points of failure on the request path: one instance, and nothing fails open around it.
  for (const c of architecture.components) {
    if (c.kind === "client" || c.kind === "cache" || c.kind === "cdn" || c.config.replicas > 1) continue;
    const m = metrics(c);
    if (!m || m.arrivalsPerSecond <= 0 || m.status === "down") continue;
    insights.push({ severity: "warning", title: `${c.label} is a single point of failure`, detail: `It runs one instance. If it crashes, ${c.kind === "database" ? "every read and write fails until it is back" : "all traffic through it fails"}.`, componentId: c.id });
  }

  // Missing cache in front of a busy, read-heavy database.
  for (const db of architecture.components.filter((c) => c.kind === "database")) {
    const fedByCache = architecture.connections.some((x) => x.target === db.id && byId.get(x.source)?.kind === "cache");
    const m = metrics(db);
    if (!fedByCache && m && m.utilization > 0.5 && estimateWriteShare(architecture) < 0.3) {
      insights.push({ severity: "info", title: `Reads go straight to ${db.label}`, detail: `It is ${pct(m.utilization)} busy with mostly reads. A cache in front (Server → Redis → ${db.label}) would absorb repeated reads.`, componentId: db.id });
    }
  }

  const base = architecture.components.filter((c) => c.kind === "client").reduce((s, c) => s + (c.config.requestsPerSecond ?? 0), 0) * snapshot.trafficMultiplier;
  if (base > 0 && snapshot.global.offeredPerSecond > base * 1.1) {
    insights.push({ severity: "warning", title: `Retries are adding ${pct(snapshot.global.offeredPerSecond / base - 1)} extra load`, detail: "Failed requests are retried, which loads an already struggling system further. Exponential backoff, retry budgets or a circuit breaker would limit this." });
  }

  const order = { critical: 0, warning: 1, info: 2, ok: 3 } as const;
  insights.sort((a, b) => order[a.severity] - order[b.severity]);
  if (!insights.some((i) => i.severity === "critical" || i.severity === "warning")) {
    const bottleneck = snapshot.global.bottleneckId ? byId.get(snapshot.global.bottleneckId) : undefined;
    insights.unshift({
      severity: "ok",
      title: "Running within capacity",
      detail: bottleneck ? `The busiest component is ${bottleneck.label} at ${pct(snapshot.global.peakUtilization)}. It would be the first to saturate as traffic grows.` : "No traffic yet. Start the simulation.",
    });
  }
  return insights;
}

function estimateWriteShare(architecture: Architecture): number {
  const clients = architecture.components.filter((c) => c.kind === "client");
  const total = clients.reduce((s, c) => s + (c.config.requestsPerSecond ?? 0), 0);
  return total > 0 ? clients.reduce((s, c) => s + (c.config.requestsPerSecond ?? 0) * (c.config.writeRatio ?? 0), 0) / total : 0;
}

export function describeKind(kind: ComponentSpec["kind"]): string {
  return CATALOG[kind].description;
}
