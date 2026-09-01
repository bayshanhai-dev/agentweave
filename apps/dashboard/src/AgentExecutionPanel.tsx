import { Badge, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { tokenUsage } from "./agentUsage";

type Agent = { id: string; role: string; status: string };
type ExecutionEvent = {
  id?: string;
  type?: string;
  message?: string;
  content?: string;
  role?: string;
  agentId?: string;
  taskId?: string;
  toolName?: string;
  output?: string;
  elapsedMs?: number;
  occurredAt?: string;
  correlationId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};

const roles = ["pm", "pe", "backend", "frontend", "qa", "devops"];
const activeEvents = new Set(["run.started", "run.heartbeat", "turn.started", "turn.delta", "tool.started", "tool.completed"]);
const settledEvents = new Set(["task.completed", "task.failed", "turn.completed", "turn.failed", "turn.cancelled"]);

function eventText(event: ExecutionEvent): string {
  return event.output ?? event.content ?? event.message ?? (event.type ?? "event").replaceAll(".", " ");
}

function relativeTime(value?: string): string {
  if (!value) return "No signal yet";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Signal received";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function AgentExecutionPanel({ agents, events }: { agents: Agent[]; events: ExecutionEvent[] }) {
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setClockTick((tick) => tick + 1), 5_000);
    return () => window.clearInterval(interval);
  }, []);
  const cards = roles.map((role) => {
    const agent = agents.find((candidate) => candidate.role === role);
    const agentEvents = events.filter((event) => event.agentId === agent?.id || event.role === role);
    const latest = [...agentEvents].reverse().find((event) => event.type);
    const status = latest && activeEvents.has(latest.type ?? "") ? "running" : latest && settledEvents.has(latest.type ?? "") ? (latest.type === "task.failed" || latest.type === "turn.failed" ? "failed" : "idle") : agent?.status ?? "idle";
    const output = [...agentEvents].reverse().find((event) => event.type === "turn.delta" || event.type === "tool.completed" || event.type === "task.completed");
    return { role, agent, status, latest, output, usage: tokenUsage(agentEvents) };
  });
  return <Stack gap="md" className="agent-execution-panel">
    <Group justify="space-between"><div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>Live execution</Text><Title order={3}>Agent execution cards</Title></div><Badge variant="light">{cards.filter((card) => card.status === "running").length} active</Badge></Group>
    <SimpleGrid cols={{ base: 1, sm: 2, xl: 6 }} spacing="sm" className="agent-execution-grid">
      {cards.map(({ role, agent, status, latest, output, usage }) => <Card key={role} withBorder radius="md" padding="md" className={`agent-execution-card status-${status}`}>
        <Group justify="space-between" align="flex-start"><div><Text fw={800}>{role.toUpperCase()}</Text><Text size="xs" c="dimmed">{agent?.id ?? "Not registered"}</Text></div><Badge size="sm" color={status === "failed" ? "red" : status === "running" ? "yellow" : "gray"}>{status}</Badge></Group>
        <div className="agent-presence" aria-label={status === "running" ? "Agent is processing" : "Agent is listening for work"}>
          <span className="agent-presence-dot" />
          <Text size="xs" fw={600}>{status === "running" ? "Processing a live turn" : status === "failed" ? "Needs attention" : "Listening for work"}</Text>
          <Text size="xs" c="dimmed">· {relativeTime(latest?.occurredAt)}</Text>
        </div>
        <Group gap="md" mt="sm" className="agent-token-usage">
          <div><Text size="xs" c="dimmed">TOKENS</Text><Text size="sm" fw={800}>{usage.reported ? usage.totalTokens.toLocaleString() : "—"}</Text></div>
          <div><Text size="xs" c="dimmed">IN / OUT</Text><Text size="xs" fw={700}>{usage.reported ? `${usage.inputTokens.toLocaleString()} / ${usage.outputTokens.toLocaleString()}` : "Not reported"}</Text></div>
        </Group>
        <Stack gap={4} mt="sm"><Text size="xs" c="dimmed">Current task</Text><Text size="sm">{status === "running" ? latest?.taskId ?? "Active task" : "No active task"}</Text><Text size="xs" c="dimmed" mt="xs">Current tool</Text><Text size="sm">{status === "running" ? latest?.toolName ?? "Preparing provider turn" : "—"}</Text><Text size="xs" c="dimmed" mt="xs">Auditable output</Text><Text size="sm" lineClamp={3}>{output ? eventText(output) : "Monitoring the workstream event bus"}</Text><Text size="xs" c="dimmed" mt="xs">Recent event · {latest?.type ?? "none"}</Text></Stack>
      </Card>)}
    </SimpleGrid>
  </Stack>;
}
