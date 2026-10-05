import { CATALOG, COMPONENT_KINDS, type ComponentKind } from "@sds/engine";
import { KindIcon } from "./icons.tsx";
import { DRAG_MIME } from "./Canvas.tsx";

const GROUPS: { title: string; kinds: ComponentKind[] }[] = [
  { title: "Traffic", kinds: ["client", "cdn", "gateway", "loadBalancer"] },
  { title: "Compute", kinds: ["server", "worker"] },
  { title: "Data", kinds: ["cache", "database", "queue", "objectStorage"] },
];

/** Drag onto the canvas, or press Enter to add at the centre. */
export function Palette({ onAdd }: { onAdd: (kind: ComponentKind) => void }) {
  return (
    <nav className="palette" aria-label="Components">
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <ul>
            {group.kinds.filter((k) => COMPONENT_KINDS.includes(k)).map((kind) => (
              <li key={kind}>
                <button
                  className="palette-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME, kind);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onAdd(kind)}
                  title={CATALOG[kind].description}
                >
                  <span className={`node-icon kind-${kind}`}>
                    <KindIcon kind={kind} size={16} />
                  </span>
                  {CATALOG[kind].name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="palette-hint">Drag onto the canvas, then drag from a component's right edge to connect it.</p>
    </nav>
  );
}
