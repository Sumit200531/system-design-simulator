import { useEffect, useState } from "react";
import { analyze, type Architecture, type ComponentSpec } from "@sds/engine";
import { useEditor } from "./context.ts";
import { useController } from "../lib/sim-controller.ts";
import { Inspector } from "./Inspector.tsx";

type Tab = "inspect" | "analysis" | "events";

export function SidePanel({ architecture, selected }: { architecture: Architecture; selected: ComponentSpec | null }) {
  const [tab, setTab] = useState<Tab>("analysis");
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId) setTab("inspect");
  }, [selectedId]);
  const current: Tab = selected && tab === "inspect" ? "inspect" : tab === "inspect" ? "analysis" : tab;
  return (
    <aside className="side-panel">
      <div className="tabs" role="tablist">
        {(
          [
            ["inspect", selected ? selected.label : "Component"],
            ["analysis", "Analysis"],
            ["events", "Events"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={current === id} disabled={id === "inspect" && !selected} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {current === "inspect" && selected && <Inspector spec={selected} />}
        {current === "analysis" && <Analysis architecture={architecture} />}
        {current === "events" && <Events architecture={architecture} />}
      </div>
    </aside>
  );
}


function Analysis({ architecture }: { architecture: Architecture }) {
  const { controller, select } = useEditor();
  const snapshot = useController(controller, (s) => s.snapshot);
  if (snapshot.time === 0) {
    return <p className="empty">Start the simulation to see how this design behaves. Findings here are computed from the live simulation, not estimated.</p>;
  }
  const insights = analyze(architecture, snapshot);
  return (
    <ul className="insights">
      {insights.map((insight, i) => (
        <li key={i} className={`insight sev-${insight.severity}`}>
          <h3>
            {insight.componentId ? (
              <button className="link" onClick={() => select(insight.componentId!)}>
                {insight.title}
              </button>
            ) : (
              insight.title
            )}
          </h3>
          <p>{insight.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function Events({ architecture }: { architecture: Architecture }) {
  const { controller, select } = useEditor();
  const events = useController(controller, (s) => s.snapshot.events);
  if (events.length === 0) return <p className="empty">Failures, saturation and recoveries will be logged here as they happen.</p>;
  return (
    <ol className="events" aria-live="polite">
      {[...events].reverse().map((event, i) => (
        <li key={events.length - i} className={`event sev-${event.severity}`}>
          <span className="event-time">{event.time.toFixed(1)}s</span>
          {event.componentId && architecture.components.some((c) => c.id === event.componentId) ? (
            <button className="link" onClick={() => select(event.componentId!)}>
              {event.message}
            </button>
          ) : (
            <span>{event.message}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
