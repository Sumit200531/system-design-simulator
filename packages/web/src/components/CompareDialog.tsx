import { useEffect, useMemo, useRef } from "react";
import { STANDARD_SCENARIO, runScenario, type GlobalMetrics, type ScenarioSummary } from "@sds/engine";
import { toArchitecture, type Design } from "../lib/design.ts";
import { money, ms, percent, rate } from "../lib/format.ts";

interface Row {
  readonly label: string;
  readonly a: number | null;
  readonly b: number | null;
  readonly format: (v: number) => string;
  readonly better: "lower" | "higher";
}

function winner(row: Row): "A" | "B" | null {
  if (row.a === null || row.b === null) return row.a === null && row.b !== null ? "B" : row.b === null && row.a !== null ? "A" : null;
  const tolerance = Math.max(Math.abs(row.a), Math.abs(row.b)) * 0.02;
  if (Math.abs(row.a - row.b) <= tolerance) return null;
  return (row.better === "lower" ? row.a < row.b : row.a > row.b) ? "A" : "B";
}

/** Explain the outcome in plain sentences, from the measured numbers only. */
function verdict(a: ScenarioSummary, b: ScenarioSummary): string[] {
  const lines: string[] = [];
  const errorGap = Math.abs(a.errorRate - b.errorRate);
  if (errorGap >= 0.005) {
    const [good, bad, gs, bs] = a.errorRate < b.errorRate ? ["A", "B", a, b] : ["B", "A", b, a];
    lines.push(`${good} failed ${percent(gs.errorRate)} of requests against ${percent(bs.errorRate)} for ${bad}: about ${rate(bs.requestsFailed - gs.requestsFailed)} fewer failed requests over the run.`);
  }
  if (Math.abs(a.worstP95LatencyMs - b.worstP95LatencyMs) > Math.min(a.worstP95LatencyMs, b.worstP95LatencyMs) * 0.25) {
    const [good, gs, bs] = a.worstP95LatencyMs < b.worstP95LatencyMs ? ["A", a, b] : ["B", b, a];
    lines.push(`At its worst moment, ${good}'s P95 latency was ${ms(gs.worstP95LatencyMs)} against ${ms(bs.worstP95LatencyMs)}.`);
  }
  if (a.recoverySeconds !== b.recoverySeconds) {
    const describe = (name: string, s: ScenarioSummary) => (s.recoverySeconds === null ? `${name} never got back under 1% errors` : `${name} recovered ${s.recoverySeconds.toFixed(0)} s after the incident`);
    lines.push(`${describe("A", a)}; ${describe("B", b)}.`);
  }
  if (a.monthlyCost !== b.monthlyCost) {
    const [cheap, dear, cs, ds] = a.monthlyCost < b.monthlyCost ? ["A", "B", a, b] : ["B", "A", b, a];
    lines.push(`${cheap} costs ${money(ds.monthlyCost - cs.monthlyCost)}/month less than ${dear}${errorGap >= 0.005 ? ", so weigh that against reliability." : "."}`);
  }
  if (lines.length === 0) lines.push("Both designs performed within 2% of each other on every measure.");
  return lines;
}

function Chart({ title, a, b, pick, format }: { title: string; a: readonly GlobalMetrics[]; b: readonly GlobalMetrics[]; pick: (m: GlobalMetrics) => number; format: (v: number) => string }) {
  const max = Math.max(1e-9, ...a.map(pick), ...b.map(pick));
  const line = (series: readonly GlobalMetrics[]) =>
    series.map((m, i) => `${((i / Math.max(1, series.length - 1)) * 100).toFixed(2)},${(58 - (pick(m) / max) * 54).toFixed(2)}`).join(" ");
  return (
    <figure className="compare-chart">
      <figcaption>
        {title} <span className="muted">(peak {format(max)})</span>
      </figcaption>
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label={`${title} over time for designs A and B`}>
        {STANDARD_SCENARIO.steps.map((s, i) => (
          <line key={i} x1={(s.at / STANDARD_SCENARIO.durationSeconds) * 100} x2={(s.at / STANDARD_SCENARIO.durationSeconds) * 100} y1={0} y2={60} className="incident" vectorEffect="non-scaling-stroke" />
        ))}
        <polyline points={line(a)} className="series-a" vectorEffect="non-scaling-stroke" />
        <polyline points={line(b)} className="series-b" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

export function CompareDialog({ a, b, onClose, onLoad }: { a: Design; b: Design; onClose: () => void; onLoad: (design: Design) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  // The same scripted workload against both designs: a deterministic, fair comparison.
  const results = useMemo(() => ({ a: runScenario(toArchitecture(a), STANDARD_SCENARIO), b: runScenario(toArchitecture(b), STANDARD_SCENARIO) }), [a, b]);
  const sa = results.a.summary;
  const sb = results.b.summary;
  const rows: Row[] = [
    { label: "Error rate", a: sa.errorRate, b: sb.errorRate, format: (v) => percent(v), better: "lower" },
    { label: "P95 latency (traffic-weighted)", a: sa.p95LatencyMs, b: sb.p95LatencyMs, format: ms, better: "lower" },
    { label: "Worst P95 latency", a: sa.worstP95LatencyMs, b: sb.worstP95LatencyMs, format: ms, better: "lower" },
    { label: "Throughput", a: sa.throughputPerSecond, b: sb.throughputPerSecond, format: (v) => `${rate(v)}/s`, better: "higher" },
    { label: "Peak queue depth", a: sa.maxQueueDepth, b: sb.maxQueueDepth, format: rate, better: "lower" },
    { label: "Recovery after incident", a: sa.recoverySeconds, b: sb.recoverySeconds, format: (v) => `${v.toFixed(0)} s`, better: "lower" },
    { label: "Monthly cost", a: sa.monthlyCost, b: sb.monthlyCost, format: money, better: "lower" },
  ];
  return (
    <dialog ref={ref} className="compare-dialog" onClose={onClose} aria-labelledby="compare-title">
      <header>
        <h2 id="compare-title">
          A: {a.name} <span className="muted">vs</span> B: {b.name}
        </h2>
        <p className="muted">
          {STANDARD_SCENARIO.name}. {STANDARD_SCENARIO.description} Each design uses its own client traffic settings.
        </p>
      </header>
      <ul className="verdict">
        {verdict(sa, sb).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <table className="compare-table">
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">A</th>
            <th scope="col">B</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const w = winner(row);
            const show = (v: number | null) => (v === null ? "Not recovered" : row.format(v));
            return (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className={w === "A" ? "wins" : undefined}>{show(row.a)}</td>
                <td className={w === "B" ? "wins" : undefined}>{show(row.b)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="compare-charts">
        <Chart title="P95 latency" a={results.a.series} b={results.b.series} pick={(m) => m.p95LatencyMs} format={ms} />
        <Chart title="Error rate" a={results.a.series} b={results.b.series} pick={(m) => m.errorRate} format={(v) => percent(v)} />
      </div>
      <p className="legend">
        <span className="key-a">A</span> <span className="key-b">B</span> <span className="muted">Vertical lines mark the spike, the crash and recovery.</span>
      </p>
      <footer className="button-row">
        <button onClick={() => onLoad(a)}>Open A on canvas</button>
        <button onClick={() => onLoad(b)}>Open B on canvas</button>
        <button className="primary" onClick={() => ref.current?.close()}>
          Close
        </button>
      </footer>
    </dialog>
  );
}
