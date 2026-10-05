import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { CATALOG, type ComponentSpec } from "@sds/engine";
import { KindIcon } from "./icons.tsx";
import { useEditor } from "./context.ts";
import { useController } from "../lib/sim-controller.ts";
import { ms, percent, rate } from "../lib/format.ts";

export type ComponentNodeType = Node<{ spec: ComponentSpec }, "component">;

const MAX_PIPS = 12;

/**
 * A component on the canvas: identity, instance health, utilization and
 * live throughput/latency. Its outline encodes status so failures and
 * bottlenecks read at a glance across the whole diagram.
 */
export const ComponentNode = memo(function ComponentNode({ id, data, selected }: NodeProps<ComponentNodeType>) {
  const { controller } = useEditor();
  const metrics = useController(controller, (s) => s.snapshot.components[id]);
  const started = useController(controller, (s) => s.snapshot.time > 0);
  const { spec } = data;
  const definition = CATALOG[spec.kind];
  const status = started && metrics ? metrics.status : "idle";
  const failing = started && metrics && metrics.arrivalsPerSecond > 0 && metrics.successRate < 0.5 && status !== "down";

  // Brief acknowledgement when a component returns to health.
  const previous = useRef(status);
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if ((was === "down" || was === "saturated") && (status === "healthy" || status === "degraded")) {
      setRecovered(true);
      const timer = setTimeout(() => setRecovered(false), 1_400);
      return () => clearTimeout(timer);
    }
  }, [status]);

  const replicas = spec.config.replicas;
  const pips = Array.from({ length: Math.min(replicas, MAX_PIPS) }, (_, i) => {
    if (!metrics) return "up";
    if (i < metrics.replicasUp) return "up";
    if (i < metrics.replicasUp + metrics.replicasStarting) return "starting";
    return "down";
  });
  const utilization = metrics?.utilization ?? 0;
  const isClient = spec.kind === "client";

  return (
    <div
      className={`component-node status-${status}${failing ? " is-failing" : ""}${selected ? " is-selected" : ""}${recovered ? " is-recovered" : ""}`}
      aria-label={`${spec.label}, ${definition.name}, ${status}`}
    >
      {!isClient && <Handle type="target" position={Position.Left} />}
      <div className="node-head">
        <span className={`node-icon kind-${spec.kind}`}>
          <KindIcon kind={spec.kind} />
        </span>
        <span className="node-title">
          <span className="node-label">{spec.label}</span>
          <span className="node-kind">{definition.name}</span>
        </span>
      </div>
      {!isClient && (
        <div className="node-pips" aria-label={`${metrics?.replicasUp ?? replicas} of ${replicas} instances up`}>
          {pips.map((state, i) => (
            <span key={i} className={`pip pip-${state}`} />
          ))}
          {replicas > MAX_PIPS && <span className="pip-more">+{replicas - MAX_PIPS}</span>}
        </div>
      )}
      {!isClient && (
        <div className="node-util" aria-hidden="true">
          <span style={{ width: `${Math.min(100, utilization * 100)}%` }} className={utilization >= 0.95 ? "hot" : utilization >= 0.8 ? "warm" : ""} />
        </div>
      )}
      <div className="node-stats">
        {started && metrics ? (
          <>
            <span>{rate(isClient ? metrics.arrivalsPerSecond : metrics.servedPerSecond)}/s</span>
            {spec.kind === "queue" ? (
              <span>{rate(metrics.backlog)} queued</span>
            ) : metrics.hitRate !== null ? (
              <span>{percent(metrics.hitRate)} hit</span>
            ) : !isClient ? (
              <span>{percent(utilization, 0)}</span>
            ) : (
              <span>{ms(metrics.latencyMs)}</span>
            )}
          </>
        ) : (
          <span className="muted">{isClient ? `${rate(spec.config.requestsPerSecond ?? 0)} req/s` : `${rate(spec.config.capacityPerReplica * replicas)}/s capacity`}</span>
        )}
      </div>
      {status === "down" && <span className="node-badge">Down</span>}
      {status !== "down" && failing && <span className="node-badge">Failing</span>}
      {status === "saturated" && !failing && <span className="node-badge warn">Saturated</span>}
      {definition.connectsTo.length > 0 && <Handle type="source" position={Position.Right} />}
    </div>
  );
});
