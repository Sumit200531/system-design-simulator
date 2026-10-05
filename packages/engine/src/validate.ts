import { CATALOG } from "./catalog.ts";
import type { Architecture } from "./types.ts";

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly componentId?: string;
}

export function canConnect(architecture: Architecture, source: string, target: string): { ok: true } | { ok: false; reason: string } {
  const from = architecture.components.find((c) => c.id === source);
  const to = architecture.components.find((c) => c.id === target);
  if (!from || !to) return { ok: false, reason: "Unknown component." };
  if (source === target) return { ok: false, reason: "A component cannot call itself." };
  if (!CATALOG[from.kind].connectsTo.includes(to.kind)) {
    return { ok: false, reason: `${CATALOG[from.kind].name} cannot send traffic to ${CATALOG[to.kind].name}.` };
  }
  if (architecture.connections.some((c) => c.source === source && c.target === target)) {
    return { ok: false, reason: "These components are already connected." };
  }
  if (reaches(architecture, target, source)) return { ok: false, reason: "That connection would create a cycle." };
  return { ok: true };
}

function reaches(architecture: Architecture, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of architecture.connections) if (c.source === id) stack.push(c.target);
  }
  return false;
}

/** Topological order, or null if the graph has a cycle. */
export function topologicalOrder(architecture: Architecture): string[] | null {
  const indegree = new Map(architecture.components.map((c) => [c.id, 0]));
  for (const c of architecture.connections) indegree.set(c.target, (indegree.get(c.target) ?? 0) + 1);
  const ready = architecture.components.filter((c) => indegree.get(c.id) === 0).map((c) => c.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const c of architecture.connections) {
      if (c.source !== id) continue;
      const remaining = indegree.get(c.target)! - 1;
      indegree.set(c.target, remaining);
      if (remaining === 0) ready.push(c.target);
    }
  }
  return order.length === architecture.components.length ? order : null;
}

export function validateArchitecture(architecture: Architecture): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(architecture.components.map((c) => c.id));
  for (const c of architecture.connections) {
    if (!ids.has(c.source) || !ids.has(c.target)) issues.push({ severity: "error", message: "A connection points at a missing component." });
  }
  if (topologicalOrder(architecture) === null) issues.push({ severity: "error", message: "The architecture contains a cycle." });
  const clients = architecture.components.filter((c) => c.kind === "client");
  if (clients.length === 0) issues.push({ severity: "error", message: "Add a Client to generate traffic." });

  const reachable = new Set<string>();
  const stack = clients.map((c) => c.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const c of architecture.connections) if (c.source === id) stack.push(c.target);
  }
  for (const component of architecture.components) {
    const out = architecture.connections.filter((c) => c.source === component.id);
    const incoming = architecture.connections.filter((c) => c.target === component.id);
    const name = component.label;
    if (component.kind === "client" && out.length === 0) issues.push({ severity: "error", message: `${name} is not connected to anything.`, componentId: component.id });
    if (component.kind !== "client" && !reachable.has(component.id)) issues.push({ severity: "warning", message: `${name} receives no traffic.`, componentId: component.id });
    if (component.kind === "queue" && out.length === 0) issues.push({ severity: "warning", message: `${name} has no workers, so messages will pile up.`, componentId: component.id });
    if (component.kind === "worker" && !incoming.some((c) => architecture.components.find((x) => x.id === c.source)?.kind === "queue")) {
      issues.push({ severity: "warning", message: `${name} only does work when fed by a queue.`, componentId: component.id });
    }
    if ((CATALOG[component.kind].routing === "split" || component.kind === "cdn") && component.kind !== "client" && out.length === 0) {
      issues.push({ severity: "error", message: `${name} has nowhere to send requests.`, componentId: component.id });
    }
    if (component.kind === "cache" && out.length === 0) {
      issues.push({ severity: "warning", message: `${name} has no database behind it; misses and writes will fail.`, componentId: component.id });
    }
    if (component.config.replicas < 1 || !Number.isInteger(component.config.replicas)) {
      issues.push({ severity: "error", message: `${name} needs a whole number of replicas, at least 1.`, componentId: component.id });
    }
  }
  return issues;
}
