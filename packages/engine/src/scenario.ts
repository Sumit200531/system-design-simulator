import { monthlyCost } from "./catalog.ts";
import { Simulation, type ChaosAction, type GlobalMetrics } from "./simulation.ts";
import type { Architecture } from "./types.ts";

/** A scripted workload: the same script run against two designs is a fair comparison. */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly durationSeconds: number;
  /** Actions applied at given times. Component targets are chosen by kind, so one script fits any design. */
  readonly steps: readonly ScenarioStep[];
}

export type ScenarioStep =
  | { readonly at: number; readonly action: "trafficMultiplier"; readonly value: number }
  | { readonly at: number; readonly action: "killReplicaOf"; readonly kind: "server" | "database" | "cache" | "worker" }
  | { readonly at: number; readonly action: "killAllOf"; readonly kind: "server" | "database" | "cache" | "worker" }
  | { readonly at: number; readonly action: "recoverAll" };

export interface ScenarioSummary {
  readonly p95LatencyMs: number;
  readonly worstP95LatencyMs: number;
  readonly meanLatencyMs: number;
  readonly errorRate: number;
  readonly worstErrorRate: number;
  readonly throughputPerSecond: number;
  readonly requestsFailed: number;
  readonly maxQueueDepth: number;
  readonly monthlyCost: number;
  /** Seconds after the last fault until the error rate stayed under 1%; null if it never recovered. */
  readonly recoverySeconds: number | null;
}

export interface ScenarioResult {
  readonly series: readonly GlobalMetrics[];
  readonly summary: ScenarioSummary;
}

export const STANDARD_SCENARIO: Scenario = {
  name: "Peak hour with an incident",
  description: "Normal load, a 3× spike, one app server instance crashes during the spike, then everything recovers.",
  durationSeconds: 90,
  steps: [
    { at: 20, action: "trafficMultiplier", value: 3 },
    { at: 35, action: "killReplicaOf", kind: "server" },
    { at: 55, action: "trafficMultiplier", value: 1 },
    { at: 55, action: "recoverAll" },
  ],
};

function toActions(architecture: Architecture, step: ScenarioStep): ChaosAction[] {
  switch (step.action) {
    case "trafficMultiplier":
      return [{ type: "setTrafficMultiplier", multiplier: step.value }];
    case "recoverAll":
      return [{ type: "recoverAll" }];
    case "killReplicaOf":
    case "killAllOf": {
      const target = architecture.components.find((c) => c.kind === step.kind);
      if (!target) return [];
      return [{ type: step.action === "killReplicaOf" ? "killReplica" : "killComponent", componentId: target.id }];
    }
  }
}

export function runScenario(architecture: Architecture, scenario: Scenario): ScenarioResult {
  const simulation = new Simulation(architecture);
  const pending = [...scenario.steps].sort((a, b) => a.at - b.at);
  const ticks = Math.round(scenario.durationSeconds / simulation.tickSeconds);
  for (let i = 0; i < ticks; i++) {
    while (pending.length > 0 && pending[0]!.at <= simulation.now + 1e-9) {
      for (const action of toActions(architecture, pending.shift()!)) simulation.apply(action);
    }
    simulation.step();
  }
  const series = simulation.snapshot().history;
  return { series, summary: summarize(architecture, scenario, series) };
}

function summarize(architecture: Architecture, scenario: Scenario, series: readonly GlobalMetrics[]): ScenarioSummary {
  const offered = series.reduce((s, x) => s + x.offeredPerSecond, 0);
  const served = series.reduce((s, x) => s + x.throughputPerSecond, 0);
  const weighted = (pick: (x: GlobalMetrics) => number) =>
    served > 0 ? series.reduce((s, x) => s + pick(x) * x.throughputPerSecond, 0) / served : 0;
  const lastFault = Math.max(0, ...scenario.steps.filter((s) => s.action !== "recoverAll" && !(s.action === "trafficMultiplier" && s.value === 1)).map((s) => s.at));
  let recoveredAt: number | null = null;
  for (const sample of series) {
    if (sample.time <= lastFault) continue;
    if (sample.errorRate < 0.01) recoveredAt ??= sample.time;
    else recoveredAt = null;
  }
  return {
    p95LatencyMs: weighted((x) => x.p95LatencyMs),
    worstP95LatencyMs: Math.max(0, ...series.map((x) => x.p95LatencyMs)),
    meanLatencyMs: weighted((x) => x.meanLatencyMs),
    errorRate: offered > 0 ? 1 - served / offered : 0,
    worstErrorRate: Math.max(0, ...series.map((x) => x.errorRate)),
    throughputPerSecond: served / Math.max(1, series.length),
    requestsFailed: offered - served,
    maxQueueDepth: Math.max(0, ...series.map((x) => x.queueDepth)),
    monthlyCost: architecture.components.reduce((s, c) => s + monthlyCost(c.kind, c.config.replicas), 0),
    recoverySeconds: recoveredAt === null ? null : Math.max(0, recoveredAt - lastFault),
  };
}
