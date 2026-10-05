import { CATALOG, monthlyCost, type ComponentConfig, type ComponentSpec } from "@sds/engine";
import { useEditor } from "./context.ts";
import { useController } from "../lib/sim-controller.ts";
import { money, ms, percent, rate } from "../lib/format.ts";
import { KindIcon } from "./icons.tsx";

interface Field {
  readonly key: keyof ComponentConfig;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
  /** Stored as a fraction, edited as a percentage. */
  readonly percent?: boolean;
}

const COMMON: readonly Field[] = [
  { key: "replicas", label: "Instances", min: 1, max: 64, step: 1 },
  { key: "capacityPerReplica", label: "Capacity per instance", min: 10, max: 200_000, step: 10, unit: "req/s" },
  { key: "baseLatencyMs", label: "Base latency", min: 0, max: 2_000, step: 1, unit: "ms" },
  { key: "failureRate", label: "Failure rate", min: 0, max: 100, step: 0.1, unit: "%", percent: true },
  { key: "timeoutSeconds", label: "Timeout", min: 0.1, max: 60, step: 0.1, unit: "s" },
  { key: "healthCheckSeconds", label: "Health check delay", min: 0, max: 60, step: 0.5, unit: "s" },
];

const BY_KIND: Partial<Record<ComponentSpec["kind"], readonly Field[]>> = {
  client: [
    { key: "requestsPerSecond", label: "Requests per second", min: 0, max: 200_000, step: 50 },
    { key: "writeRatio", label: "Writes", min: 0, max: 100, step: 1, unit: "%", percent: true },
    { key: "retries", label: "Retries on failure", min: 0, max: 5, step: 1 },
  ],
  cache: [{ key: "hitRate", label: "Hit rate when warm", min: 0, max: 100, step: 1, unit: "%", percent: true }],
  cdn: [{ key: "hitRate", label: "Hit rate when warm", min: 0, max: 100, step: 1, unit: "%", percent: true }],
  queue: [{ key: "maxDepth", label: "Max depth", min: 100, max: 10_000_000, step: 100, unit: "messages" }],
};

export function Inspector({ spec }: { spec: ComponentSpec }) {
  const { controller, updateConfig, rename, remove } = useEditor();
  const metrics = useController(controller, (s) => s.snapshot.components[spec.id]);
  const started = useController(controller, (s) => s.snapshot.time > 0);
  const definition = CATALOG[spec.kind];
  const fields = spec.kind === "client" ? BY_KIND.client! : [...COMMON, ...(BY_KIND[spec.kind] ?? [])];
  const isClient = spec.kind === "client";

  return (
    <div className="inspector">
      <header className="inspector-head">
        <span className={`node-icon kind-${spec.kind}`}>
          <KindIcon kind={spec.kind} />
        </span>
        <div>
          <label className="visually-hidden" htmlFor="component-name">
            Name
          </label>
          <input id="component-name" className="name-input" value={spec.label} onChange={(e) => rename(spec.id, e.target.value)} />
          <p className="muted">{definition.description}</p>
        </div>
      </header>

      {started && metrics && (
        <dl className="live-grid">
          <div>
            <dt>{isClient ? "Sending" : "Serving"}</dt>
            <dd>{rate(isClient ? metrics.arrivalsPerSecond : metrics.servedPerSecond)}/s</dd>
          </div>
          {!isClient && (
            <div>
              <dt>Utilization</dt>
              <dd className={metrics.utilization >= 0.95 ? "bad" : metrics.utilization >= 0.8 ? "warn" : ""}>{percent(metrics.utilization, 0)}</dd>
            </div>
          )}
          <div>
            <dt>Latency from here</dt>
            <dd>{ms(metrics.latencyMs)}</dd>
          </div>
          <div>
            <dt>Success from here</dt>
            <dd className={metrics.successRate < 0.95 ? "bad" : ""}>{percent(metrics.successRate)}</dd>
          </div>
          {metrics.failuresPerSecond > 0.5 && (
            <div>
              <dt>Failing here</dt>
              <dd className="bad">{rate(metrics.failuresPerSecond)}/s</dd>
            </div>
          )}
          {metrics.backlog >= 1 && (
            <div>
              <dt>{spec.kind === "queue" ? "Queued" : "Waiting"}</dt>
              <dd>{rate(metrics.backlog)}</dd>
            </div>
          )}
          {metrics.lagSeconds !== null && metrics.backlog >= 1 && (
            <div>
              <dt>Consumer lag</dt>
              <dd>{metrics.lagSeconds.toFixed(1)} s</dd>
            </div>
          )}
          {metrics.warmth !== null && (
            <div>
              <dt>Cache warmth</dt>
              <dd>{percent(metrics.warmth, 0)}</dd>
            </div>
          )}
        </dl>
      )}

      <form className="fields" onSubmit={(e) => e.preventDefault()}>
        {fields.map((field) => {
          const raw = spec.config[field.key];
          const value = typeof raw === "number" ? (field.percent ? raw * 100 : raw) : 0;
          return (
            <label key={field.key} className="field">
              <span>{field.label}</span>
              <span className="field-input">
                <input
                  type="number"
                  inputMode="decimal"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={Number.isFinite(value) ? Number(value.toFixed(3)) : ""}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (!Number.isFinite(parsed) || e.target.value === "") return;
                    const clamped = Math.min(field.max, Math.max(field.min, parsed));
                    const stored = field.key === "replicas" || field.key === "retries" ? Math.round(clamped) : field.percent ? clamped / 100 : clamped;
                    updateConfig(spec.id, { [field.key]: stored });
                  }}
                />
                {field.unit && <span className="unit">{field.unit}</span>}
              </span>
            </label>
          );
        })}
      </form>

      {!isClient && <p className="muted small">Estimated cost: {money(monthlyCost(spec.kind, spec.config.replicas))}/month at on-demand prices.</p>}
      {spec.kind === "database" && <p className="muted small">Instance 1 is the primary and takes every write; the others are read replicas.</p>}

      {!isClient && <ComponentChaos spec={spec} />}

      <button className="danger-link" onClick={() => remove(spec.id)}>
        Remove {spec.label}
      </button>
    </div>
  );
}

function ComponentChaos({ spec }: { spec: ComponentSpec }) {
  const { controller } = useEditor();
  const metrics = useController(controller, (s) => s.snapshot.components[spec.id]);
  const apply = controller.apply.bind(controller);
  const down = (metrics?.replicasDown ?? 0) > 0;
  const slowed = (metrics?.addedLatencyMs ?? 0) > 0;
  return (
    <section className="component-chaos" aria-label={`Fault injection for ${spec.label}`}>
      <h3>Fault injection</h3>
      <div className="button-row">
        <button onClick={() => apply({ type: "killReplica", componentId: spec.id })} disabled={(metrics?.replicasUp ?? spec.config.replicas) === 0}>
          Crash one instance
        </button>
        <button onClick={() => apply({ type: "killComponent", componentId: spec.id })}>Crash all</button>
        <button onClick={() => apply({ type: "setAddedLatency", componentId: spec.id, ms: slowed ? 0 : 250 })} aria-pressed={slowed}>
          {slowed ? "Remove latency" : "Add 250 ms latency"}
        </button>
        {down && (
          <button className="recover" onClick={() => apply({ type: "restartComponent", componentId: spec.id })}>
            Restart
          </button>
        )}
      </div>
    </section>
  );
}
