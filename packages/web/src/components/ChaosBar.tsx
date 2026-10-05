import type { Architecture, ChaosAction, Snapshot } from "@sds/engine";
import { useEditor } from "./context.ts";
import { useController } from "../lib/sim-controller.ts";

interface Experiment {
  readonly label: string;
  readonly hint: string;
  readonly target: string | null;
  readonly active: boolean;
  readonly action: () => ChaosAction[];
}

const SPIKE = 5;
const LATENCY_MS = 300;
const SLOWDOWN = 0.15;

function busiest(architecture: Architecture, snapshot: Snapshot, kind: string): string | null {
  const candidates = architecture.components.filter((c) => c.kind === kind);
  candidates.sort((a, b) => (snapshot.components[b.id]?.arrivalsPerSecond ?? 0) - (snapshot.components[a.id]?.arrivalsPerSecond ?? 0));
  return candidates[0]?.id ?? null;
}

/**
 * One-click experiments. Targets are chosen from the design (the busiest
 * component of the right kind), so the same button works on any architecture.
 */
export function ChaosBar({ architecture }: { architecture: Architecture }) {
  const { controller } = useEditor();
  const snapshot = useController(controller, (s) => s.snapshot);
  const server = busiest(architecture, snapshot, "server");
  const database = busiest(architecture, snapshot, "database");
  const cache = busiest(architecture, snapshot, "cache");
  const queue = busiest(architecture, snapshot, "queue");
  const workers = queue ? architecture.connections.filter((c) => c.source === queue).map((c) => c.target) : [];
  const name = (id: string | null) => architecture.components.find((c) => c.id === id)?.label ?? "";
  const latencyOn = database !== null && (snapshot.components[database]?.addedLatencyMs ?? 0) > 0;
  const slowOn = workers.some((w) => (snapshot.components[w]?.consumerSlowdown ?? 1) < 1);

  const experiments: Experiment[] = [
    { label: "Kill server", hint: `Crash one instance of ${name(server)}`, target: server, active: false, action: () => [{ type: "killReplica", componentId: server! }] },
    { label: "Kill database", hint: `Crash every instance of ${name(database)}`, target: database, active: false, action: () => [{ type: "killComponent", componentId: database! }] },
    {
      label: snapshot.trafficMultiplier > 1 ? `Spike ×${SPIKE} on` : `Traffic spike ×${SPIKE}`,
      hint: "Multiply incoming traffic",
      target: "global",
      active: snapshot.trafficMultiplier > 1,
      action: () => [{ type: "setTrafficMultiplier", multiplier: snapshot.trafficMultiplier > 1 ? 1 : SPIKE }],
    },
    {
      label: latencyOn ? `+${LATENCY_MS} ms on` : "Network latency",
      hint: `Add ${LATENCY_MS} ms between the app and ${name(database)}`,
      target: database,
      active: latencyOn,
      action: () => [{ type: "setAddedLatency", componentId: database!, ms: latencyOn ? 0 : LATENCY_MS }],
    },
    { label: "Cache failure", hint: `Crash ${name(cache)}; it comes back cold`, target: cache, active: false, action: () => [{ type: "killComponent", componentId: cache! }] },
    {
      label: slowOn ? "Consumers slowed" : "Queue overload",
      hint: `Slow ${name(queue)}'s consumers to ${SLOWDOWN * 100}% speed`,
      target: workers.length > 0 ? queue : null,
      active: slowOn,
      action: () => workers.map((w) => ({ type: "setConsumerSlowdown", componentId: w, factor: slowOn ? 1 : SLOWDOWN }) as ChaosAction),
    },
  ];

  return (
    <section className="chaos-bar" aria-label="Chaos experiments">
      <span className="chaos-title">Chaos</span>
      {experiments.map((experiment) => (
        <button
          key={experiment.label}
          className={`chaos-button${experiment.active ? " is-active" : ""}`}
          aria-pressed={experiment.active}
          disabled={experiment.target === null}
          title={experiment.target === null ? "Add a matching component to the design first" : experiment.hint}
          onClick={() => experiment.action().forEach((a) => controller.apply(a))}
        >
          {experiment.label}
        </button>
      ))}
      <button className="chaos-button recover" onClick={() => controller.apply({ type: "recoverAll" })}>
        Recover all
      </button>
    </section>
  );
}
