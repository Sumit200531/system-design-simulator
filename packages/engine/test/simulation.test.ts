import { describe, expect, it } from "vitest";
import {
  CATALOG,
  STANDARD_SCENARIO,
  Simulation,
  canConnect,
  meanQueueingDelaySeconds,
  percentile,
  runScenario,
  validateArchitecture,
  type Architecture,
  type ComponentConfig,
  type ComponentKind,
} from "../src/index.ts";

type Node = [id: string, kind: ComponentKind, overrides?: Partial<ComponentConfig>];

function design(nodes: Node[], edges: [string, string][]): Architecture {
  return {
    components: nodes.map(([id, kind, overrides]) => ({ id, kind, label: id, config: { ...CATALOG[kind].defaults, ...overrides } })),
    connections: edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
  };
}

const exact = { failureRate: 0 };
const noRetry = { retries: 0 };

describe("queueing math", () => {
  it("reduces to the exact M/M/1 result for one server", () => {
    // M/M/1: Wq = ρ / (1 − ρ) × S
    expect(meanQueueingDelaySeconds(0.5, 1, 0.01)).toBeCloseTo(0.01, 10);
    expect(meanQueueingDelaySeconds(0.9, 1, 0.01)).toBeCloseTo(0.09, 10);
  });

  it("waits less with more servers at the same utilization", () => {
    expect(meanQueueingDelaySeconds(0.8, 8, 0.01)).toBeLessThan(meanQueueingDelaySeconds(0.8, 1, 0.01) / 4);
  });

  it("solves percentiles of an exponential exactly", () => {
    // p95 of Exp(mean m) = −ln(0.05) m ≈ 2.9957 m
    expect(percentile([{ p: 1, fixedMs: 10, expMs: 100 }], 0.95)).toBeCloseTo(10 + 299.57, 0);
  });

  it("captures a bimodal tail that a mean would hide", () => {
    const mixture = [
      { p: 0.9, fixedMs: 2, expMs: 0 },
      { p: 0.1, fixedMs: 50, expMs: 0 },
    ];
    expect(percentile(mixture, 0.5)).toBeCloseTo(2, 0);
    expect(percentile(mixture, 0.95)).toBeCloseTo(50, 0);
  });
});

describe("Simulation", () => {
  const simple = (rps: number, overrides: Partial<ComponentConfig> = {}) =>
    design(
      [
        ["client", "client", { requestsPerSecond: rps, writeRatio: 0, ...noRetry }],
        ["app", "server", { replicas: 2, capacityPerReplica: 800, ...exact, ...overrides }],
      ],
      [["client", "app"]],
    );

  it("is deterministic", () => {
    const run = () => {
      const sim = new Simulation(simple(1_200));
      sim.advance(10);
      sim.apply({ type: "killReplica", componentId: "app" });
      sim.advance(10);
      return JSON.stringify(sim.snapshot());
    };
    expect(run()).toBe(run());
  });

  it("serves everything under capacity, with utilization equal to load over capacity", () => {
    const sim = new Simulation(simple(800));
    sim.advance(5);
    const { global, components } = sim.snapshot();
    expect(global.throughputPerSecond).toBeCloseTo(800, 6);
    expect(global.errorRate).toBe(0);
    expect(components.app!.utilization).toBeCloseTo(0.5, 6);
  });

  it("caps throughput at capacity and sheds the excess as timeouts when overloaded", () => {
    const sim = new Simulation(simple(2_000));
    sim.advance(10); // longer than the 2 s timeout, so the backlog is full
    const { global, components } = sim.snapshot();
    expect(global.throughputPerSecond).toBeCloseTo(1_600, 0);
    expect(global.errorRate).toBeCloseTo(0.2, 2);
    // A full backlog means requests wait about the timeout before being served.
    expect(components.app!.backlog).toBeCloseTo(1_600 * 2, 0);
    expect(global.p95LatencyMs).toBeGreaterThan(2_000);
  });

  it("makes latency grow non-linearly as utilization approaches 100%", () => {
    const p95At = (rps: number) => {
      const sim = new Simulation(simple(rps));
      sim.advance(3);
      return sim.snapshot().global.p95LatencyMs;
    };
    const base = CATALOG.client.defaults.baseLatencyMs + 25;
    const half = p95At(800) - base;
    const ninety = p95At(1_440) - base;
    expect(ninety).toBeGreaterThan(half * 5);
  });

  it("keeps sending traffic to a crashed instance until the health check notices", () => {
    const sim = new Simulation(simple(900, { replicas: 3 }));
    sim.advance(2);
    sim.apply({ type: "killReplica", componentId: "app" });
    sim.advance(1);
    // One of three instances is dead but still in rotation: a third of requests fail.
    expect(sim.snapshot().global.errorRate).toBeCloseTo(1 / 3, 3);
    sim.advance(3); // past the 3 s health check
    const after = sim.snapshot();
    expect(after.global.errorRate).toBe(0);
    expect(after.components.app!.utilization).toBeCloseTo(900 / 1_600, 6);
    expect(after.events.some((e) => e.message.includes("health check removed"))).toBe(true);
  });

  it("recovers crashed instances after a restart delay", () => {
    const sim = new Simulation(simple(500, { replicas: 2 }));
    sim.apply({ type: "killComponent", componentId: "app" });
    sim.advance(1);
    expect(sim.snapshot().global.errorRate).toBe(1);
    sim.apply({ type: "restartComponent", componentId: "app" });
    sim.advance(2);
    expect(sim.snapshot().components.app!.replicasStarting).toBe(2);
    sim.advance(3);
    expect(sim.snapshot().global.errorRate).toBe(0);
  });

  it("scales reads with database replicas but sends every write to the primary", () => {
    const db = (replicas: number, writeRatio: number) =>
      design(
        [
          ["client", "client", { requestsPerSecond: 3_000, writeRatio, ...noRetry }],
          ["app", "server", { replicas: 10, capacityPerReplica: 1_000, ...exact }],
          ["db", "database", { replicas, capacityPerReplica: 1_500, ...exact }],
        ],
        [["client", "app"], ["app", "db"]],
      );
    const errorRate = (arch: Architecture) => {
      const sim = new Simulation(arch);
      sim.advance(10);
      return sim.snapshot().global.errorRate;
    };
    // Read-heavy: adding replicas fixes the overload.
    expect(errorRate(db(1, 0))).toBeGreaterThan(0.4);
    expect(errorRate(db(3, 0))).toBe(0);
    // Write-heavy: 2,400 writes/s exceed one primary's 1,500/s; the 900/s excess
    // fails however many read replicas are added.
    expect(errorRate(db(3, 0.8))).toBeCloseTo(900 / 3_000, 3);
    expect(errorRate(db(10, 0.8))).toBeCloseTo(errorRate(db(3, 0.8)), 6);
  });

  describe("caching", () => {
    const cached = design(
      [
        ["client", "client", { requestsPerSecond: 2_000, writeRatio: 0.1, ...noRetry }],
        ["app", "server", { replicas: 4, capacityPerReplica: 1_000, ...exact }],
        ["redis", "cache", { hitRate: 0.9, ...exact }],
        ["db", "database", { replicas: 1, capacityPerReplica: 1_500, ...exact }],
      ],
      [["client", "app"], ["app", "redis"], ["redis", "db"]],
    );

    it("absorbs reads but never writes", () => {
      const sim = new Simulation(cached);
      sim.advance(5);
      const { components, global } = sim.snapshot();
      // 1,800 reads × 10% misses + 200 writes reach the database.
      expect(components.db!.arrivalsPerSecond).toBeCloseTo(180 + 200, 6);
      expect(global.cacheHitRate).toBeCloseTo(0.9, 6);
      expect(global.errorRate).toBe(0);
    });

    it("fails open to the database, and comes back cold, causing a thundering herd", () => {
      const sim = new Simulation(cached);
      sim.advance(5);
      sim.apply({ type: "killComponent", componentId: "redis" });
      // Overload turns into errors once the backlog exceeds the 2 s timeout (~6 s here).
      sim.advance(10);
      const outage = sim.snapshot();
      // Every request now hits a database sized for cache misses only.
      expect(outage.components.db!.arrivalsPerSecond).toBeCloseTo(2_000, 0);
      expect(outage.components.db!.status).toBe("saturated");
      expect(outage.global.errorRate).toBeGreaterThan(0.2);

      sim.apply({ type: "restartComponent", componentId: "redis" });
      sim.advance(4.5);
      const justBack = sim.snapshot().components.redis!;
      expect(justBack.warmth!).toBeLessThan(0.5);
      sim.advance(30);
      const warm = sim.snapshot();
      expect(warm.components.redis!.warmth!).toBeGreaterThan(0.95);
      expect(warm.global.errorRate).toBeLessThan(0.01);
    });
  });

  describe("queues", () => {
    const pipeline = (workers: number) =>
      design(
        [
          ["client", "client", { requestsPerSecond: 1_000, writeRatio: 1, ...noRetry }],
          ["api", "server", { replicas: 4, capacityPerReplica: 1_000, ...exact }],
          ["kafka", "queue", { maxDepth: 50_000, ...exact }],
          ["worker", "worker", { replicas: workers, capacityPerReplica: 300, ...exact }],
        ],
        [["client", "api"], ["api", "kafka"], ["kafka", "worker"]],
      );

    it("decouples producers from slow consumers: latency stays low while the backlog grows", () => {
      const sim = new Simulation(pipeline(2)); // consumers: 600/s for 1,000/s produced
      sim.advance(20);
      const { global, components } = sim.snapshot();
      expect(global.errorRate).toBe(0);
      expect(global.p95LatencyMs).toBeLessThan(200);
      expect(components.kafka!.backlog).toBeCloseTo(400 * 20, -1);
      expect(components.kafka!.lagSeconds!).toBeGreaterThan(10);
    });

    it("rejects producers once the queue is full", () => {
      const sim = new Simulation(pipeline(2));
      sim.advance(130); // 400/s × 125 s fills 50,000
      const { global } = sim.snapshot();
      expect(global.errorRate).toBeCloseTo(0.4, 2);
    });

    it("redelivers jobs whose processing failed", () => {
      const arch = design(
        [
          ["client", "client", { requestsPerSecond: 100, writeRatio: 1, ...noRetry }],
          ["api", "server", exact],
          ["kafka", "queue", exact],
          ["worker", "worker", { replicas: 2, capacityPerReplica: 300, failureRate: 0.5 }],
        ],
        [["client", "api"], ["api", "kafka"], ["kafka", "worker"]],
      );
      const sim = new Simulation(arch);
      sim.advance(10);
      // At-least-once delivery: with half of attempts failing, workers process ~2× the produced rate.
      expect(sim.snapshot().global.asyncProcessedPerSecond).toBeCloseTo(200, 0);
    });
  });

  it("amplifies load with retries while the system is failing", () => {
    const withRetries = design(
      [
        ["client", "client", { requestsPerSecond: 2_000, writeRatio: 0, retries: 3 }],
        ["app", "server", { replicas: 2, capacityPerReplica: 800, ...exact }],
      ],
      [["client", "app"]],
    );
    const sim = new Simulation(withRetries);
    sim.advance(10);
    const { global } = sim.snapshot();
    expect(global.offeredPerSecond).toBeGreaterThan(2_000 * 1.3);
    expect(global.throughputPerSecond).toBeCloseTo(1_600, 0);
  });

  it("propagates a database outage up through healthy servers", () => {
    const arch = design(
      [
        ["client", "client", { requestsPerSecond: 500, ...noRetry }],
        ["lb", "loadBalancer", exact],
        ["app", "server", exact],
        ["db", "database", exact],
      ],
      [["client", "lb"], ["lb", "app"], ["app", "db"]],
    );
    const sim = new Simulation(arch);
    sim.advance(2);
    sim.apply({ type: "killComponent", componentId: "db" });
    sim.advance(5);
    const { global, components, connections } = sim.snapshot();
    expect(components.app!.status).not.toBe("down");
    expect(global.errorRate).toBe(1);
    expect(connections["lb->app"]!.errorRate).toBe(1);
  });

  it("keeps state when the design is edited live", () => {
    const sim = new Simulation(simple(2_000));
    sim.advance(10);
    expect(sim.snapshot().global.errorRate).toBeGreaterThan(0);
    sim.setArchitecture(simple(2_000, { replicas: 4 }));
    sim.advance(1);
    expect(sim.snapshot().components.app!.replicasStarting).toBe(2); // new instances boot
    sim.advance(10);
    expect(sim.snapshot().global.errorRate).toBe(0);
  });
});

describe("validation", () => {
  const arch = design(
    [
      ["client", "client"],
      ["app", "server"],
      ["db", "database"],
    ],
    [["client", "app"], ["app", "db"]],
  );

  it("allows sensible connections and rejects invalid ones", () => {
    expect(canConnect(arch, "client", "db")).toMatchObject({ ok: false });
    expect(canConnect(arch, "db", "app")).toMatchObject({ ok: false });
    expect(canConnect(arch, "app", "db")).toMatchObject({ ok: false }); // duplicate
    expect(canConnect(design([["a", "server"], ["b", "server"]], [["a", "b"]]), "b", "a")).toMatchObject({ ok: false, reason: expect.stringContaining("cycle") });
  });

  it("reports a missing client and unreachable components", () => {
    const issues = validateArchitecture(design([["app", "server"], ["db", "database"]], [["app", "db"]]));
    expect(issues.map((i) => i.message).join(" ")).toContain("Add a Client");
    expect(validateArchitecture(arch)).toEqual([]);
  });
});

describe("scenarios", () => {
  it("shows a redundant, cached design surviving the incident that breaks a naive one", () => {
    const naive = design(
      [
        ["client", "client", { requestsPerSecond: 600 }],
        ["app", "server", { replicas: 1 }],
        ["db", "database"],
      ],
      [["client", "app"], ["app", "db"]],
    );
    const scalable = design(
      [
        ["client", "client", { requestsPerSecond: 600 }],
        ["lb", "loadBalancer"],
        ["app", "server", { replicas: 4 }],
        ["redis", "cache"],
        ["db", "database", { replicas: 2 }],
      ],
      [["client", "lb"], ["lb", "app"], ["app", "redis"], ["redis", "db"]],
    );
    const a = runScenario(naive, STANDARD_SCENARIO).summary;
    const b = runScenario(scalable, STANDARD_SCENARIO).summary;
    expect(b.errorRate).toBeLessThan(a.errorRate / 5);
    expect(b.worstP95LatencyMs).toBeLessThan(a.worstP95LatencyMs);
    expect(b.monthlyCost).toBeGreaterThan(a.monthlyCost);
    expect(a.recoverySeconds).not.toBeNull();
  });
});
