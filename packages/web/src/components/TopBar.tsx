import type { ComponentSpec } from "@sds/engine";
import { SPEEDS } from "../lib/sim-controller.ts";
import { useController } from "../lib/sim-controller.ts";
import { useEditor } from "./context.ts";
import { PRESETS, type Design } from "../lib/design.ts";
import { rate } from "../lib/format.ts";
import type { Slot } from "../lib/saved.ts";

const MIN_RPS = 10;
const MAX_RPS = 100_000;
const toSlider = (rps: number) => Math.log10(Math.max(MIN_RPS, rps));
const fromSlider = (v: number) => {
  const raw = Math.pow(10, v);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  return Math.round(raw / magnitude) * magnitude;
};

interface TopBarProps {
  readonly client: ComponentSpec | null;
  readonly blocked: string | null;
  readonly slots: Partial<Record<Slot, Design>>;
  readonly onLoadPreset: (design: Design) => void;
  readonly onSave: (slot: Slot) => void;
  readonly onCompare: () => void;
}

export function TopBar({ client, blocked, slots, onLoadPreset, onSave, onCompare }: TopBarProps) {
  const { controller, updateConfig } = useEditor();
  const running = useController(controller, (s) => s.running);
  const speed = useController(controller, (s) => s.speed);
  const time = useController(controller, (s) => s.snapshot.time);
  const rps = client?.config.requestsPerSecond ?? 0;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <h1>System Design Simulator</h1>
      </div>
      <div className="transport">
        <button className={`run${running ? " is-running" : ""}`} onClick={() => (running ? controller.pause() : controller.start())} disabled={!running && blocked !== null} title={blocked ?? undefined}>
          {running ? "❚❚ Pause" : time > 0 ? "▶ Resume" : "▶ Start simulation"}
        </button>
        <button onClick={() => controller.reset()} disabled={time === 0}>
          Reset
        </button>
        <span className="clock" aria-label="Simulated time">
          {formatClock(time)}
        </span>
        <div className="segmented" role="radiogroup" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button key={s} role="radio" aria-checked={speed === s} className={speed === s ? "is-active" : ""} onClick={() => controller.setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
      </div>
      {client && (
        <label className="traffic">
          <span>Traffic</span>
          <input
            type="range"
            min={toSlider(MIN_RPS)}
            max={toSlider(MAX_RPS)}
            step={0.01}
            value={toSlider(rps)}
            onChange={(e) => updateConfig(client.id, { requestsPerSecond: fromSlider(Number(e.target.value)) })}
            aria-valuetext={`${rps} requests per second`}
          />
          <output>{rate(rps)} req/s</output>
        </label>
      )}
      <div className="design-actions">
        <select
          aria-label="Load a template"
          value=""
          onChange={(e) => {
            const preset = PRESETS.find((p) => p.name === e.target.value);
            if (preset) onLoadPreset(preset);
          }}
        >
          <option value="">Templates…</option>
          {PRESETS.map((p) => (
            <option key={p.name}>{p.name}</option>
          ))}
        </select>
        <button onClick={() => onSave("A")} title={slots.A ? `Replace saved design A (${slots.A.name})` : "Save this design as A"}>
          Save as A
        </button>
        <button onClick={() => onSave("B")} title={slots.B ? `Replace saved design B (${slots.B.name})` : "Save this design as B"}>
          Save as B
        </button>
        <button className="primary" onClick={onCompare} disabled={!slots.A || !slots.B} title={!slots.A || !slots.B ? "Save two designs first" : "Run the same workload against A and B"}>
          Compare A/B
        </button>
      </div>
    </header>
  );
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
