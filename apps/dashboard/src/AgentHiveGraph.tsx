import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type Props = { selected: string | null; onSelect: (id: string | null) => void; onEdgeSelect: (source: string, target: string) => void };

const nodes: Node[] = [
  { id: "human", position: { x: 250, y: 0 }, data: { label: "Human" }, className: "graph-node graph-human" },
  { id: "pm", position: { x: 60, y: 130 }, data: { label: "PM\nlead" }, className: "graph-node graph-lead" },
  { id: "pe", position: { x: 260, y: 130 }, data: { label: "PE\nreviewer" }, className: "graph-node graph-reviewer" },
  { id: "coder", position: { x: 460, y: 130 }, data: { label: "Coder\nexecutor" }, className: "graph-node graph-executor" },
  { id: "qa", position: { x: 260, y: 270 }, data: { label: "QA\nreviewer" }, className: "graph-node graph-reviewer" },
];

const edges: Edge[] = [
  ["human", "pm"], ["human", "pe"], ["human", "coder"], ["human", "qa"],
  ["pm", "pe"], ["pm", "coder"], ["pm", "qa"], ["pe", "coder"], ["pe", "qa"], ["coder", "qa"], ["qa", "pm"],
].map(([source, target]) => ({ id: `${source}-${target}`, source, target, animated: true, style: { stroke: "#91a176", strokeWidth: 1.5 } }));

export function AgentHiveGraph({ selected, onSelect, onEdgeSelect }: Props) {
  return <div className="graph-frame"><ReactFlow nodes={nodes.map((node) => ({ ...node, selected: node.id === selected }))} edges={edges} fitView fitViewOptions={{ padding: 0.2 }} nodesDraggable nodesConnectable={false} onNodeClick={(_, node) => onSelect(selected === node.id ? null : node.id)} onEdgeClick={(_, edge) => onEdgeSelect(edge.source, edge.target)}><Background color="#91a176" gap={22} size={1} /><Controls showInteractive={false} /></ReactFlow></div>;
}
