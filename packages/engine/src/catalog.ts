import type { ComponentConfig, ComponentKind } from "./types.ts";

/**
 * How each kind of component routes the requests it successfully handles:
 *  - split:   distribute across downstream targets (load balancing)
 *  - fanout:  every request calls every downstream dependency, in sequence
 *  - lookaside: serve hits locally, forward misses and writes (caches, CDNs)
 *  - async:   buffer and deliver to consumers; the producer does not wait
 *  - terminal: no downstream
 */
export type Routing = "split" | "fanout" | "lookaside" | "async" | "terminal";

export interface ComponentDefinition {
  readonly kind: ComponentKind;
  readonly name: string;
  readonly description: string;
  readonly routing: Routing;
  readonly defaults: ComponentConfig;
  /** Rough on-demand cost per instance per month, for comparing designs, not budgeting. */
  readonly monthlyCostPerReplica: number;
  /** Which kinds this component may send traffic to. */
  readonly connectsTo: readonly ComponentKind[];
}

const BASE = { failureRate: 0, timeoutSeconds: 2, healthCheckSeconds: 3 } as const;
const BACKENDS: readonly ComponentKind[] = ["server", "cache", "database", "queue", "objectStorage"];

export const CATALOG: Readonly<Record<ComponentKind, ComponentDefinition>> = {
  client: {
    kind: "client",
    name: "Client",
    description: "Users generating traffic.",
    routing: "split",
    defaults: { ...BASE, replicas: 1, capacityPerReplica: Number.POSITIVE_INFINITY, baseLatencyMs: 20, requestsPerSecond: 1_000, writeRatio: 0.1, retries: 1 },
    monthlyCostPerReplica: 0,
    connectsTo: ["cdn", "gateway", "loadBalancer", "server"],
  },
  cdn: {
    kind: "cdn",
    name: "CDN",
    description: "Edge cache for cacheable reads.",
    routing: "lookaside",
    defaults: { ...BASE, replicas: 1, capacityPerReplica: 1_000_000, baseLatencyMs: 8, hitRate: 0.6 },
    monthlyCostPerReplica: 50,
    connectsTo: ["gateway", "loadBalancer", "server", "objectStorage"],
  },
  gateway: {
    kind: "gateway",
    name: "API Gateway",
    description: "Authentication, rate limiting and routing.",
    routing: "split",
    defaults: { ...BASE, replicas: 2, capacityPerReplica: 20_000, baseLatencyMs: 3 },
    monthlyCostPerReplica: 60,
    connectsTo: ["loadBalancer", "server", "queue"],
  },
  loadBalancer: {
    kind: "loadBalancer",
    name: "Load Balancer",
    description: "Round-robin across healthy targets.",
    routing: "split",
    defaults: { ...BASE, replicas: 1, capacityPerReplica: 50_000, baseLatencyMs: 1 },
    monthlyCostPerReplica: 25,
    connectsTo: ["server"],
  },
  server: {
    kind: "server",
    name: "App Server",
    description: "Stateless application service.",
    routing: "fanout",
    defaults: { ...BASE, replicas: 2, capacityPerReplica: 800, baseLatencyMs: 25 },
    monthlyCostPerReplica: 70,
    connectsTo: BACKENDS,
  },
  cache: {
    kind: "cache",
    name: "Redis",
    description: "In-memory cache in front of a database. Fails open to the database.",
    routing: "lookaside",
    defaults: { ...BASE, replicas: 1, capacityPerReplica: 50_000, baseLatencyMs: 1, hitRate: 0.85 },
    monthlyCostPerReplica: 55,
    connectsTo: ["database"],
  },
  database: {
    kind: "database",
    name: "PostgreSQL",
    description: "Primary for writes; extra replicas serve reads only.",
    routing: "terminal",
    defaults: { ...BASE, replicas: 1, capacityPerReplica: 1_500, baseLatencyMs: 8 },
    monthlyCostPerReplica: 220,
    connectsTo: [],
  },
  queue: {
    kind: "queue",
    name: "Kafka",
    description: "Durable buffer between producers and workers.",
    routing: "async",
    defaults: { ...BASE, replicas: 3, capacityPerReplica: 30_000, baseLatencyMs: 4, maxDepth: 200_000 },
    monthlyCostPerReplica: 120,
    connectsTo: ["worker"],
  },
  worker: {
    kind: "worker",
    name: "Worker",
    description: "Consumes queued jobs. Failed jobs are redelivered.",
    routing: "fanout",
    defaults: { ...BASE, replicas: 2, capacityPerReplica: 300, baseLatencyMs: 40 },
    monthlyCostPerReplica: 70,
    connectsTo: ["database", "cache", "objectStorage", "server"],
  },
  objectStorage: {
    kind: "objectStorage",
    name: "Object Storage",
    description: "S3-style blob storage.",
    routing: "terminal",
    defaults: { ...BASE, replicas: 1, capacityPerReplica: 5_000, baseLatencyMs: 30 },
    monthlyCostPerReplica: 25,
    connectsTo: [],
  },
};

export const COMPONENT_KINDS = Object.keys(CATALOG) as ComponentKind[];

export function monthlyCost(kind: ComponentKind, replicas: number): number {
  return CATALOG[kind].monthlyCostPerReplica * replicas;
}
