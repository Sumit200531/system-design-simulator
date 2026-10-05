import { CATALOG, type Architecture, type ComponentConfig, type ComponentKind, type ComponentSpec, type ConnectionSpec } from "@sds/engine";

/** A design as the editor sees it: the engine's architecture plus canvas positions. */
export interface PlacedComponent extends ComponentSpec {
  readonly position: { readonly x: number; readonly y: number };
}

export interface Design {
  readonly name: string;
  readonly components: readonly PlacedComponent[];
  readonly connections: readonly ConnectionSpec[];
}

export function toArchitecture(design: Pick<Design, "components" | "connections">): Architecture {
  return {
    components: design.components.map(({ position: _position, ...spec }) => spec),
    connections: design.connections,
  };
}

let counter = 0;
export function newId(kind: ComponentKind): string {
  counter += 1;
  return `${kind}-${Date.now().toString(36)}-${counter}`;
}

export function placed(id: string, kind: ComponentKind, x: number, y: number, overrides: Partial<ComponentConfig> = {}, label?: string): PlacedComponent {
  return { id, kind, label: label ?? CATALOG[kind].name, config: { ...CATALOG[kind].defaults, ...overrides }, position: { x, y } };
}

const link = (source: string, target: string): ConnectionSpec => ({ id: `${source}->${target}`, source, target });

const COLUMN = 250;

export const PRESETS: readonly Design[] = [
  {
    name: "Scalable web app",
    components: [
      placed("client", "client", 0, 160, { requestsPerSecond: 3_000 }, "Users"),
      placed("cdn", "cdn", COLUMN, 160),
      placed("gateway", "gateway", COLUMN * 2, 160),
      placed("lb", "loadBalancer", COLUMN * 3, 160),
      placed("api", "server", COLUMN * 4, 160, { replicas: 3 }, "API servers"),
      placed("redis", "cache", COLUMN * 5, 160),
      placed("postgres", "database", COLUMN * 6, 160, { replicas: 2, capacityPerReplica: 600 }),
    ],
    connections: [link("client", "cdn"), link("cdn", "gateway"), link("gateway", "lb"), link("lb", "api"), link("api", "redis"), link("redis", "postgres")],
  },
  {
    name: "Event-driven pipeline",
    components: [
      placed("client", "client", 0, 160, { requestsPerSecond: 1_000, writeRatio: 0.9 }, "Producers"),
      placed("gateway", "gateway", COLUMN, 160),
      placed("api", "server", COLUMN * 2, 160, { replicas: 2 }, "Ingest API"),
      placed("kafka", "queue", COLUMN * 3, 160),
      placed("worker", "worker", COLUMN * 4, 160, { replicas: 4 }, "Workers"),
      placed("postgres", "database", COLUMN * 5, 60),
      placed("s3", "objectStorage", COLUMN * 5, 270),
    ],
    connections: [link("client", "gateway"), link("gateway", "api"), link("api", "kafka"), link("kafka", "worker"), link("worker", "postgres"), link("worker", "s3")],
  },
  {
    name: "Starter monolith",
    components: [
      placed("client", "client", 0, 160, { requestsPerSecond: 500 }, "Users"),
      placed("app", "server", COLUMN, 160, { replicas: 1 }, "Monolith"),
      placed("postgres", "database", COLUMN * 2, 160),
    ],
    connections: [link("client", "app"), link("app", "postgres")],
  },
];

export function connectionId(source: string, target: string): string {
  return `${source}->${target}`;
}
