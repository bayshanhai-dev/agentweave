import { Alert, Badge, Card, Group, List, Modal, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";
import { useState } from "react";
import { displayTaskTitle } from "./unified-stream";

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

export type TaskLane = {
  status: string;
  label: string;
  color: string;
};

type AgentLike = { id: string; role: string };

export const DEFAULT_LANES: TaskLane[] = [
  { status: "ready", label: "Backlog", color: "gray" },
  { status: "assigned", label: "To Do", color: "blue" },
  { status: "running", label: "In Progress", color: "yellow" },
  { status: "review", label: "Review", color: "violet" },
  { status: "done", label: "Done", color: "green" },
];

const statusColors: Record<string, string> = {
  ready: "gray", assigned: "blue", running: "yellow", review: "violet",
  blocked: "orange", done: "green", cancelled: "gray", failed: "red",
};

function ownerLabel(task: Task, agents?: AgentLike[]): string {
  if (!task.ownerAgentId) return "Unassigned";
  const agent = agents?.find((candidate) => candidate.id === task.ownerAgentId);
  if (agent) return agent.role.toUpperCase();
  return task.ownerAgentId.split(":").at(-1)?.replace(/-\d+$/, "").toUpperCase() ?? task.ownerAgentId;
}

function TaskDetail({ task, agents }: { task: Task; agents?: AgentLike[] }) {
  return (
    <Stack gap="md">
      <div>
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>Task</Text>
        <Title order={3}>{displayTaskTitle(task.title)}</Title>
      </div>
      <Group gap="xs">
        <Badge size="lg" variant="light" color={statusColors[task.status] ?? "gray"}>{task.status}</Badge>
        <Badge variant="light">Owner · {ownerLabel(task, agents)}</Badge>
      </Group>
      <div>
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>Acceptance criteria</Text>
        {task.acceptanceCriteria.length ? (
          <List size="sm" mt="xs" spacing="xs" icon={<IconCheck size={14} />}>
            {task.acceptanceCriteria.map((criterion) => <List.Item key={criterion}>{criterion}</List.Item>)}
          </List>
        ) : <Text size="sm" c="dimmed" mt="xs">No acceptance criteria</Text>}
      </div>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <div>
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>Dependencies</Text>
          <Text size="sm" mt="xs">{task.dependencies.length ? task.dependencies.join(", ") : "None"}</Text>
        </div>
        <div>
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>Evidence</Text>
          {task.evidence.length ? (
            <Group gap="xs" mt="xs">{task.evidence.map((evidence) => <Badge key={evidence} variant="light">{evidence}</Badge>)}</Group>
          ) : <Text size="sm" mt="xs" c="dimmed">No evidence attached yet</Text>}
        </div>
      </SimpleGrid>
      <Text size="xs" c="dimmed">Task ID · {task.id}</Text>
    </Stack>
  );
}

/** Kanban task board: one column per task lane, running tasks highlighted. */
/** Collaboration stage ("proposal", "critique", …) encoded in the task title prefix, if any. */
function taskKind(title: string): string | undefined {
  const match = /^\[Collaboration:\s*([^\]]+)\]/i.exec(title);
  return match ? match[1].trim() : undefined;
}

export function TaskBoard({ tasks, lanes, agents, embedded = false }: { tasks: Task[]; lanes?: TaskLane[]; agents?: AgentLike[]; embedded?: boolean }) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  if (!tasks.length) {
    const empty = (
      <Alert icon={<IconAlertCircle size={18} />} title="No tasks yet">
        Tasks created by the Orchestrator will appear here.
      </Alert>
    );
    return embedded ? empty : <div className="cc-panel">{empty}</div>;
  }
  const columns = lanes?.length ? lanes : DEFAULT_LANES;
  const overflow = tasks.filter((task) => !columns.some((column) => column.status === task.status));
  // Only populated lanes earn a column, in the page tab and in the
  // sidecar (embedded) alike: empty lanes are named once, in one muted
  // line, and the board's width goes to the lanes that hold work.
  const populated = columns
    .map((column) => ({ column, columnTasks: tasks.filter((task) => task.status === column.status) }))
    .filter(({ columnTasks }) => columnTasks.length > 0);
  const emptyLabels = columns
    .filter((column) => !populated.some(({ column: kept }) => kept.status === column.status))
    .map((column) => column.label);

  return (
    <div className={embedded ? "cc-taskboard cc-taskboard-embedded" : "cc-panel cc-taskboard"}>
      {!embedded && (
        <Group justify="space-between" mb="md">
          <Text fw={800}>Task board</Text>
          <Badge variant="light">{tasks.length} tasks</Badge>
        </Group>
      )}
      {emptyLabels.length > 0 && (
        <Text size="xs" c="dimmed" mb="sm">
          No tasks in {emptyLabels.join(" · ")}
        </Text>
      )}
      <div className="cc-kanban">
        {populated.map(({ column, columnTasks }) => {
          return (
            <div key={column.status} className="cc-kanban-lane">
              <div className="cc-kanban-lane-header">
                <Badge color={column.color} variant="light" size="sm">{columnTasks.length}</Badge>
                <Text fw={700} size="sm">{column.label}</Text>
              </div>
              <div className="cc-kanban-lane-body">
                {columnTasks.length === 0 && (
                  <Text size="xs" c="dimmed">No tasks</Text>
                )}
                {columnTasks.map((task) => (
                  <Card
                    key={task.id}
                    withBorder
                    padding="sm"
                    radius="md"
                    className={`cc-kanban-card${task.status === "running" ? " cc-kanban-card-running" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open task: ${displayTaskTitle(task.title)}`}
                    onClick={() => setSelectedTask(task)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedTask(task); }
                    }}
                  >
                    <Text fw={700} size="sm" className="cc-kanban-card-title">{displayTaskTitle(task.title)}</Text>
                    <Group gap="xs" mt={6} wrap="wrap">
                      {taskKind(task.title) && (
                        <Badge size="xs" variant="light" color="grape">
                          {taskKind(task.title)}
                        </Badge>
                      )}
                      <Badge size="xs" variant="light" color={task.ownerAgentId ? "blue" : "gray"}>
                        {ownerLabel(task, agents)}
                      </Badge>
                      {task.status === "running" && <Badge size="xs" color="yellow" variant="filled">Running</Badge>}
                    </Group>
                  </Card>
                ))}
              </div>
            </div>
          );
        })}
        {overflow.length > 0 && (
          <div className="cc-kanban-lane">
            <div className="cc-kanban-lane-header">
              <Badge color="gray" variant="light" size="sm">{overflow.length}</Badge>
              <Text fw={700} size="sm">Other</Text>
            </div>
            <div className="cc-kanban-lane-body">
              {overflow.map((task) => (
                <Card key={task.id} withBorder padding="sm" radius="md" className="cc-kanban-card" role="button" tabIndex={0} onClick={() => setSelectedTask(task)}>
                  <Text fw={700} size="sm">{displayTaskTitle(task.title)}</Text>
                  <Text size="xs" c="dimmed" mt={4}>{task.status}</Text>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
      <Modal opened={Boolean(selectedTask)} onClose={() => setSelectedTask(null)} title="Task details" size="lg" centered>
        {selectedTask && <TaskDetail task={selectedTask} agents={agents} />}
      </Modal>
    </div>
  );
}
