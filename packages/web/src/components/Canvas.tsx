import { useCallback, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import { canConnect, type Architecture, type ComponentKind } from "@sds/engine";
import { ComponentNode, type ComponentNodeType } from "./ComponentNode.tsx";
import { FlowEdge } from "./FlowEdge.tsx";

const nodeTypes = { component: ComponentNode };
const edgeTypes = { flow: FlowEdge };
export const DRAG_MIME = "application/x-sds-component";

interface CanvasProps {
  readonly nodes: ComponentNodeType[];
  readonly edges: Edge[];
  readonly architecture: Architecture;
  readonly onNodesChange: OnNodesChange<ComponentNodeType>;
  readonly onEdgesChange: OnEdgesChange;
  readonly onConnect: (connection: Connection) => void;
  readonly onDropComponent: (kind: ComponentKind, position: { x: number; y: number }) => void;
  readonly onSelect: (id: string | null) => void;
  readonly onRejectConnection: (reason: string) => void;
}

export function Canvas(props: CanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(DRAG_MIME) as ComponentKind;
      if (!kind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      props.onDropComponent(kind, { x: position.x - 84, y: position.y - 40 });
    },
    [props, screenToFlowPosition],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => connection.source !== null && connection.target !== null && canConnect(props.architecture, connection.source, connection.target).ok,
    [props.architecture],
  );

  const onConnectEnd = useCallback(
    (_: unknown, state: { isValid: boolean | null; fromNode: { id: string } | null; toNode: { id: string } | null }) => {
      if (state.isValid === false && state.fromNode && state.toNode) {
        const verdict = canConnect(props.architecture, state.fromNode.id, state.toNode.id);
        if (!verdict.ok) props.onRejectConnection(verdict.reason);
      }
    },
    [props],
  );

  return (
    <div className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <ReactFlow
        nodes={props.nodes}
        edges={props.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={props.onNodesChange}
        onEdgesChange={props.onEdgesChange}
        onConnect={props.onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onSelectionChange={({ nodes }) => props.onSelect(nodes[0]?.id ?? null)}
        defaultEdgeOptions={{ type: "flow" }}
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} className="canvas-grid" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable className="minimap" nodeClassName={(n) => `mini-${(n.data as ComponentNodeType["data"]).spec.kind}`} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
