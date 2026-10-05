import type { ComponentKind } from "@sds/engine";

/** One consistent line-icon set, drawn on a 24-unit grid. */
const PATHS: Record<ComponentKind, string> = {
  client: "M4 5h16v11H4zM9 20h6M12 16v4",
  cdn: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  gateway: "M4 12h4M16 12h4M8 7l4-3 4 3v10l-4 3-4-3z",
  loadBalancer: "M12 4v5M12 9L5 15M12 9v6M12 9l7 6M3 15h4v4H3zM10 15h4v4h-4zM17 15h4v4h-4z",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  cache: "M13 3L5 13h6l-1 8 8-10h-6z",
  database: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  queue: "M3 8h4v8H3zM10 8h4v8h-4zM17 8h4v8h-4z",
  worker: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  objectStorage: "M4 7l8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10",
};

export function KindIcon({ kind, size = 18 }: { kind: ComponentKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[kind]} />
    </svg>
  );
}
