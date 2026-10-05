/**
 * Architecture model. Plain data: the UI edits it, the engine simulates it,
 * and it serializes to JSON for saved designs and comparisons.
 */

export type ComponentKind =
  | "client"
  | "cdn"
  | "gateway"
  | "loadBalancer"
  | "server"
  | "cache"
  | "database"
  | "queue"
  | "worker"
  | "objectStorage";

export interface ComponentConfig {
  /** Number of identical instances. For databases: 1 primary + (replicas - 1) read replicas. */
  readonly replicas: number;
  /** Requests per second one instance can serve at 100% utilization. */
  readonly capacityPerReplica: number;
  /** Processing time per request when the instance is idle (network + compute + I/O). */
  readonly baseLatencyMs: number;
  /** Fraction of served requests that fail even when healthy (bugs, dropped connections). */
  readonly failureRate: number;
  /** Longest a request waits in this component's queue before timing out. */
  readonly timeoutSeconds: number;
  /** Seconds before a dead instance is detected and taken out of rotation. */
  readonly healthCheckSeconds: number;
  /** Cache and CDN: fraction of reads served without going downstream, once warm. */
  readonly hitRate?: number;
  /** Queue: messages the queue can hold before rejecting producers. */
  readonly maxDepth?: number;
  /** Client: offered load before chaos multipliers and retries. */
  readonly requestsPerSecond?: number;
  /** Client: fraction of requests that are writes. Caches and CDNs cannot absorb writes. */
  readonly writeRatio?: number;
  /** Client: times a failed request is retried. */
  readonly retries?: number;
}

export interface ComponentSpec {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly label: string;
  readonly config: ComponentConfig;
}

export interface ConnectionSpec {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface Architecture {
  readonly components: readonly ComponentSpec[];
  readonly connections: readonly ConnectionSpec[];
}

/** Traffic as a rate vector. Reads and writes behave differently at caches and databases. */
export interface Traffic {
  readonly reads: number;
  readonly writes: number;
}
