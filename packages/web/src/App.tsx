import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge } from "@xyflow/react";
import { CATALOG, canConnect, validateArchitecture, type Architecture, type ComponentConfig, type ComponentKind } from "@sds/engine";
import { Canvas } from "./components/Canvas.tsx";
import type { ComponentNodeType } from "./components/ComponentNode.tsx";
import { Palette } from "./components/Palette.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { ChaosBar } from "./components/ChaosBar.tsx";
import { MetricsStrip } from "./components/MetricsStrip.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { CompareDialog } from "./components/CompareDialog.tsx";
import { EditorContext, type EditorApi } from "./components/context.ts";
import { SimController } from "./lib/sim-controller.ts";
import { PRESETS, connectionId, newId, placed, type Design } from "./lib/design.ts";
import { loadSlots, saveSlot, type Slot } from "./lib/saved.ts";

const AUTOSAVE_KEY = "sds:autosave:v1";
const TOAST_MS = 3_500;

function toNodes(design: Design): ComponentNodeType[] {
  return design.components.map(({ position, ...spec }) => ({ id: spec.id, type: "component", position, data: { spec } }));
}

function toEdges(design: Design): Edge[] {
  return design.connections.map((c) => ({ id: c.id, source: c.source, target: c.target, type: "flow" }));
}

function loadAutosave(): Design | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? (JSON.parse(raw) as Design) : null;
  } catch {
    return null;
  }
}

export function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

function Editor() {
  const [initial] = useState(() => loadAutosave() ?? PRESETS[0]!);
  const [designName, setDesignName] = useState(initial.name);
  const [nodes, setNodes, onNodesChange] = useNodesState<ComponentNodeType>(toNodes(initial));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toEdges(initial));
  const [toast, setToast] = useState<string | null>(null);
  const [slots, setSlots] = useState(loadSlots);
  const [comparing, setComparing] = useState(false);
  const { fitView, screenToFlowPosition } = useReactFlow();

  // Positions change on every drag frame; the engine only cares about specs and connections.
  const signature = JSON.stringify([nodes.map((n) => n.data.spec), edges.map((e) => [e.id, e.source, e.target])]);
  const architecture = useMemo<Architecture>(
    () => ({ components: nodes.map((n) => n.data.spec), connections: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  const [controller] = useState(() => new SimController(architecture));
  useEffect(() => controller.setArchitecture(architecture), [controller, architecture]);
  useEffect(() => () => controller.dispose(), [controller]);

  const design = useCallback(
    (): Design => ({
      name: designName,
      components: nodes.map((n) => ({ ...n.data.spec, position: n.position })),
      connections: architecture.connections,
    }),
    [designName, nodes, architecture.connections],
  );

  useEffect(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(design()));
    } catch {
      // Autosave is a convenience; ignore storage failures.
    }
  }, [design]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const issues = useMemo(() => validateArchitecture(architecture), [architecture]);
  const blocking = issues.find((i) => i.severity === "error")?.message ?? null;

  const updateSpec = useCallback(
    (id: string, update: (spec: ComponentNodeType["data"]["spec"]) => ComponentNodeType["data"]["spec"]) =>
      setNodes((current) => current.map((n) => (n.id === id ? { ...n, data: { spec: update(n.data.spec) } } : n))),
    [setNodes],
  );

  const api = useMemo<EditorApi>(
    () => ({
      controller,
      select: (id) => setNodes((current) => current.map((n) => ({ ...n, selected: n.id === id }))),
      updateConfig: (id, patch: Partial<ComponentConfig>) => updateSpec(id, (spec) => ({ ...spec, config: { ...spec.config, ...patch } })),
      rename: (id, label) => updateSpec(id, (spec) => ({ ...spec, label })),
      remove: (id) => {
        setNodes((current) => current.filter((n) => n.id !== id));
        setEdges((current) => current.filter((e) => e.source !== id && e.target !== id));
      },
    }),
    [controller, setNodes, setEdges, updateSpec],
  );

  const addComponent = useCallback(
    (kind: ComponentKind, position: { x: number; y: number }) => {
      const sameKind = nodes.filter((n) => n.data.spec.kind === kind).length;
      const label = sameKind === 0 ? CATALOG[kind].name : `${CATALOG[kind].name} ${sameKind + 1}`;
      const component = placed(newId(kind), kind, position.x, position.y, {}, label);
      setNodes((current) => [
        ...current.map((n) => ({ ...n, selected: false })),
        { id: component.id, type: "component", position: component.position, data: { spec: { id: component.id, kind, label, config: component.config } }, selected: true },
      ]);
    },
    [nodes, setNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const verdict = canConnect(architecture, connection.source, connection.target);
      if (!verdict.ok) {
        setToast(verdict.reason);
        return;
      }
      setEdges((current) => addEdge({ ...connection, id: connectionId(connection.source, connection.target), type: "flow" }, current));
    },
    [architecture, setEdges],
  );

  const loadDesign = useCallback(
    (next: Design) => {
      controller.reset();
      setNodes(toNodes(next));
      setEdges(toEdges(next));
      setDesignName(next.name);
      setComparing(false);
      requestAnimationFrame(() => fitView({ padding: 0.25, duration: 300 }));
    },
    [controller, setNodes, setEdges, fitView],
  );

  const selected = nodes.find((n) => n.selected)?.data.spec ?? null;
  const client = nodes.find((n) => n.data.spec.kind === "client")?.data.spec ?? null;
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.data.spec.label ?? id;

  return (
    <EditorContext.Provider value={api}>
      <div className="app">
        <TopBar
          client={client}
          blocked={blocking}
          slots={slots}
          onLoadPreset={loadDesign}
          onSave={(slot: Slot) => {
            setSlots((current) => saveSlot(slot, design(), current));
            setToast(`Saved “${designName}” as design ${slot}.`);
          }}
          onCompare={() => setComparing(true)}
        />
        <div className="workspace">
          <div className="left-rail">
            <label className="design-name">
              <span>Design</span>
              <input value={designName} onChange={(e) => setDesignName(e.target.value)} />
            </label>
            <Palette
              onAdd={(kind) => {
                const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
                addComponent(kind, { x: centre.x - 84, y: centre.y - 40 });
              }}
            />
            {issues.length > 0 && (
              <section className="issues" aria-label="Design check">
                <h2>Design check</h2>
                <ul>
                  {issues.map((issue, i) => (
                    <li key={i} className={`issue-${issue.severity}`}>
                      {issue.componentId ? (
                        <button className="link" onClick={() => api.select(issue.componentId!)}>
                          {issue.message}
                        </button>
                      ) : (
                        issue.message
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <main className="stage">
            <ChaosBar architecture={architecture} />
            <Canvas
              nodes={nodes}
              edges={edges}
              architecture={architecture}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onDropComponent={addComponent}
              onSelect={() => undefined}
              onRejectConnection={setToast}
            />
            <MetricsStrip labelOf={labelOf} />
          </main>
          <SidePanel architecture={architecture} selected={selected} />
        </div>
        <p className={`toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">
          {toast}
        </p>
        {comparing && slots.A && slots.B && <CompareDialog a={slots.A} b={slots.B} onClose={() => setComparing(false)} onLoad={loadDesign} />}
      </div>
    </EditorContext.Provider>
  );
}
