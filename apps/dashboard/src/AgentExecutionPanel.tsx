import { Badge, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";

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
};

const roles = ["pm", "pe", "backend", "frontend", "qa", "devops"];
const activeEvents = new Set(["run.started", "run.heartbeat", "turn.started", "turn.delta", "tool.started", "tool.completed"]);
const settledEvents = new Set(["task.completed", "task.failed", "turn.completed", "turn.failed", "turn.cancelled"]);

function eventText(event: ExecutionEvent): string {
  return event.output ?? event.content ?? event.message ?? (event.type ?? "event").replaceAll(".", " ");
}

export function AgentExecutionPanel({ agents, events }: { agents: Agent[]; events: ExecutionEvent[] }) {
  const cards = roles.map((role) => {
    const agent = agents.find((candidate) => candidate.role === role);
    const agentEvents = events.filter((event) => event.agentId === agent?.id || event.role === role);
    const latest = [...agentEvents].reverse().find((event) => event.type);
    const status = latest && activeEvents.has(latest.type ?? "") ? "running" : latest && settledEvents.has(latest.type ?? "") ? (latest.type === "task.failed" || latest.type === "turn.failed" ? "failed" : "idle") : agent?.status ?? "idle";
    const output = [...agentEvents].reverse().find((event) => event.type === "turn.delta" || event.type === "tool.completed" || event.type === "task.completed");
    return { role, agent, status, latest, output };
  });
  return <Stack gap="md" className="agent-execution-panel">
    <Group justify="space-between"><div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>Live execution</Text><Title order={3}>Agent execution cards</Title></div><Badge variant="light">{cards.filter((card) => card.status === "running").length} active</Badge></Group>
    <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="sm">
      {cards.map(({ role, agent, status, latest, output }) => <Card key={role} withBorder radius="md" padding="md" className={`agent-execution-card status-${status}`}>
        <Group justify="space-between" align="flex-start"><div><Text fw={800}>{role.toUpperCase()}</Text><Text size="xs" c="dimmed">{agent?.id ?? "Not registered"}</Text></div><Badge size="sm" color={status === "failed" ? "red" : status === "running" ? "yellow" : "gray"}>{status}</Badge></Group>
        <Stack gap={4} mt="md"><Text size="xs" c="dimmed">Current task</Text><Text size="sm">{latest?.taskId ?? "No active task"}</Text><Text size="xs" c="dimmed" mt="xs">Current tool</Text><Text size="sm">{latest?.toolName ?? "—"}</Text><Text size="xs" c="dimmed" mt="xs">Auditable output</Text><Text size="sm" lineClamp={3}>{output ? eventText(output) : "No provider or tool output yet"}</Text><Text size="xs" c="dimmed" mt="xs">Recent event · {latest?.type ?? "none"}</Text></Stack>
      </Card>)}
    </SimpleGrid>
  </Stack>;
}
