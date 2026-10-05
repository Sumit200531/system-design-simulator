import type { GlobalMetrics } from "@sds/engine";
import { useEditor } from "./context.ts";
import { useController } from "../lib/sim-controller.ts";
import { ms, percent, rate } from "../lib/format.ts";

const WINDOW = 120;

function Sparkline({ values, tone }: { values: number[]; tone: string }) {
  if (values.length < 2) return <svg className="spark" aria-hidden="true" />;
  const max = Math.max(...values, 1e-9);
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(28 - (v / max) * 26).toFixed(2)}`).join(" ");
  return (
    <svg className={`spark tone-${tone}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface Tile {
  readonly label: string;
  readonly value: string;
  readonly pick: (m: GlobalMetrics) => number;
  readonly tone: string;
  readonly alert?: boolean;
  readonly note?: string;
}

/** Live system-wide metrics, each with its last two minutes as a sparkline. */
export function MetricsStrip({ labelOf }: { labelOf: (id: string) => string }) {
  const { controller } = useEditor();
  const global = useController(controller, (s) => s.snapshot.global);
  const history = useController(controller, (s) => s.snapshot.history);
  const recent = history.slice(-WINDOW);
  const tiles: Tile[] = [
    { label: "Requests/s", value: rate(global.offeredPerSecond), pick: (m) => m.offeredPerSecond, tone: "traffic" },
    { label: "Throughput", value: `${rate(global.throughputPerSecond)}/s`, pick: (m) => m.throughputPerSecond, tone: "ok" },
    { label: "Mean latency", value: ms(global.meanLatencyMs), pick: (m) => m.meanLatencyMs, tone: "traffic" },
    { label: "P95 latency", value: ms(global.p95LatencyMs), pick: (m) => m.p95LatencyMs, tone: "warn", alert: global.p95LatencyMs > 1_000 },
    { label: "Error rate", value: percent(global.errorRate), pick: (m) => m.errorRate, tone: "bad", alert: global.errorRate >= 0.01 },
    { label: "Queue depth", value: rate(global.queueDepth), pick: (m) => m.queueDepth, tone: "async", alert: global.queueDepth > 10_000 },
    {
      label: "Peak utilization",
      value: percent(global.peakUtilization, 0),
      pick: (m) => m.peakUtilization,
      tone: "warn",
      alert: global.peakUtilization >= 0.95,
      ...(global.bottleneckId ? { note: labelOf(global.bottleneckId) } : {}),
    },
    { label: "Cache hit rate", value: global.cacheHitRate === null ? "—" : percent(global.cacheHitRate, 0), pick: (m) => m.cacheHitRate ?? 0, tone: "ok" },
  ];
  return (
    <section className="metrics-strip" aria-label="Live metrics">
      {tiles.map((tile) => (
        <div key={tile.label} className={`metric${tile.alert ? " is-alert" : ""}`}>
          <span className="metric-label">{tile.label}</span>
          <span className="metric-value">{tile.value}</span>
          {tile.note && <span className="metric-note">{tile.note}</span>}
          <Sparkline values={recent.map(tile.pick)} tone={tile.tone} />
        </div>
      ))}
    </section>
  );
}
