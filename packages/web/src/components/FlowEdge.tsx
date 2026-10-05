import { memo } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useEditor } from "./context.ts";
import { useController } from "../lib/sim-controller.ts";
import { usePrefersReducedMotion } from "./hooks.ts";

/** Particle count grows with the log of the rate, so 50 req/s and 50,000 req/s both read clearly. */
function particlesFor(rate: number): number {
  if (rate <= 0.5) return 0;
  return Math.max(1, Math.min(7, Math.round(Math.log10(rate) * 1.6)));
}

/**
 * A connection. While the simulation runs, particles travel along it at a
 * density set by the real request rate; the share of red particles is the
 * share of requests on this connection that fail downstream.
 */
export const FlowEdge = memo(function FlowEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const { controller } = useEditor();
  const metrics = useController(controller, (s) => s.snapshot.connections[id]);
  const running = useController(controller, (s) => s.running);
  const reduced = usePrefersReducedMotion();
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const rate = metrics?.ratePerSecond ?? 0;
  const errorRate = metrics?.errorRate ?? 0;
  const count = particlesFor(rate);
  const failing = rate > 0 && errorRate >= 0.5;
  const degraded = rate > 0 && errorRate >= 0.02;
  const className = `flow-edge${failing ? " is-failing" : degraded ? " is-degraded" : ""}${rate > 0 ? " is-active" : ""}${selected ? " is-selected" : ""}`;
  const duration = 1.8;
  const red = Math.round(count * errorRate);

  return (
    <>
      <BaseEdge id={id} path={path} className={className} />
      {running && !reduced && count > 0 && (
        <g className="particles" key={`${count}-${red}`}>
          {Array.from({ length: count }, (_, i) => (
            <circle key={i} r={2.4} className={i < red ? "particle particle-error" : "particle"}>
              <animateMotion dur={`${duration}s`} repeatCount="indefinite" path={path} begin={`${(-duration * i) / count}s`} />
            </circle>
          ))}
        </g>
      )}
    </>
  );
});
