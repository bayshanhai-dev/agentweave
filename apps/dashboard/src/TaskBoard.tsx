import { Alert, Badge, Card, Divider, Group, List, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";

export type Task = {
  id: string;
  title: string;
  status: string;
  ownerAgentId?: string;
  createdByAgentId?: string;
  parentTaskId?: string;
  relatedTaskIds: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  evidence: string[];
};

const statusLabels: Record<string, string> = {
  ready: "Backlog", assigned: "Assigned", running: "In progress", review: "In review",
  blocked: "Blocked", done: "Done", cancelled: "Cancelled", failed: "Failed",
};
const statusColors: Record<string, string> = {
  ready: "gray", assigned: "blue", running: "yellow", review: "violet",
  blocked: "orange", done: "green", cancelled: "gray", failed: "red",
};

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return <Alert icon={<IconAlertCircle size={18} />} title="No tasks yet">Tasks created by the Orchestrator will appear here.</Alert>;
  return <Stack gap="md">{tasks.map((task) =>
    <Card key={task.id} withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>Task</Text>
          <Title order={4} mt={4}>{task.title}</Title>
          <Text size="xs" c="dimmed" mt={6}>Owner · {task.ownerAgentId ?? "Unassigned"}{task.createdByAgentId ? ` · Created by ${task.createdByAgentId}` : ""}</Text>
        </div>
        <Stack gap={4} align="flex-end">
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>Agent-managed status</Text>
          <Badge size="lg" variant="light" color={statusColors[task.status] ?? "gray"}>{statusLabels[task.status] ?? task.status}</Badge>
        </Stack>
      </Group>
      <Divider my="md" />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <div><Text size="xs" tt="uppercase" fw={700} c="dimmed">Acceptance criteria</Text><List size="sm" mt="xs" spacing="xs" icon={<IconCheck size={14} />}>{task.acceptanceCriteria.map((criterion) => <List.Item key={criterion}>{criterion}</List.Item>)}</List></div>
        <div><Text size="xs" tt="uppercase" fw={700} c="dimmed">Task relationships</Text><Text size="sm" mt="xs">{task.parentTaskId ? `Parent · ${task.parentTaskId}` : "Independent task"}</Text><Text size="sm" c="dimmed">{task.dependencies.length ? `Blocked by · ${task.dependencies.join(", ")}` : "No dependencies"}</Text><Text size="sm" c="dimmed">{task.relatedTaskIds.length ? `Related · ${task.relatedTaskIds.join(", ")}` : "No related tasks"}</Text></div>
        <div><Text size="xs" tt="uppercase" fw={700} c="dimmed">Evidence</Text>{task.evidence.length ? <Group gap="xs" mt="xs">{task.evidence.map((evidence) => <Badge key={evidence} variant="light">{evidence}</Badge>)}</Group> : <Text size="sm" mt="xs" c="dimmed">No evidence attached yet</Text>}</div>
      </SimpleGrid>
    </Card>,
  )}</Stack>;
}
