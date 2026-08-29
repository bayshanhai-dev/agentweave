import "@mantine/core/styles.css";
import "@xyflow/react/dist/style.css";
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Card,
  Center,
  Divider,
  Group,
  MantineProvider,
  NavLink,
  Paper,
  Pagination,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
  IconActivity,
  IconArrowsExchange,
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCircleDot,
  IconLayoutDashboard,
  IconLayoutKanban,
  IconMessage,
  IconMoon,
  IconPlus,
  IconSun,
  IconTopologyStar3,
} from "@tabler/icons-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentHiveGraph } from "./AgentHiveGraph";
import { AgentExecutionPanel } from "./AgentExecutionPanel";
import { SummaryReport } from "./SummaryReport";
import { TaskBoard, type Task } from "./TaskBoard";
import { WorkstreamControls } from "./WorkstreamControls";
import { RunConsole } from "./RunConsole";
import { LiveMessageBus } from "./LiveMessageBus";
import "./styles.css";

const api = `${window.location.protocol}//${window.location.hostname}:3000`;
const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:3000/events`;
type Event = {
  id?: string;
  type?: string;
  message?: string;
  content?: string;
  senderId?: string;
  agentId?: string;
  taskId?: string;
  toolName?: string;
  output?: string;
  elapsedMs?: number;
  recipientIds?: string[];
  messageType?: string;
  taskId?: string;
  correlationId?: string;
  role?: string;
  from?: string;
  to?: string;
  occurredAt?: string;
  createdAt?: string;
};
type Agent = { id: string; role: string; authority: string; status: string };
type Workstream = {
  id: string;
  goal: string;
  flavor: string;
  status: string;
  provider: { tool: string; model: string };
  workspaceRoot: string;
  agents: Agent[];
  tasks: Task[];
  events: Event[];
  messages?: Event[];
};
const pages = [
  { value: "Overview", label: "Overview", icon: IconLayoutDashboard },
  { value: "Agent hive", label: "Agent Hive", icon: IconTopologyStar3 },
  { value: "Tasks", label: "Tasks", icon: IconCheck },
  { value: "Activity", label: "Activity", icon: IconActivity },
];
const labels: Record<string, string> = {
  human: "Human",
  pm: "PM",
  pe: "PE",
  coder: "Coder",
  qa: "QA",
};
function MessageList({
  events,
  empty = "No messages yet",
  paginated = false,
  pageSize = 10,
}: {
  events: Event[];
  empty?: string;
  paginated?: boolean;
  pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  const orderedEvents = useMemo(
    () =>
      events
        .map((event, index) => ({ event, index }))
        .sort((a, b) => {
          const aTime = Date.parse(a.event.occurredAt ?? a.event.createdAt ?? "");
          const bTime = Date.parse(b.event.occurredAt ?? b.event.createdAt ?? "");
          if (Number.isNaN(aTime) && Number.isNaN(bTime)) return b.index - a.index;
          if (Number.isNaN(aTime)) return 1;
          if (Number.isNaN(bTime)) return -1;
          return bTime - aTime || b.index - a.index;
        })
        .map(({ event }) => event),
    [events],
  );
  const totalPages = paginated ? Math.max(1, Math.ceil(orderedEvents.length / pageSize)) : 1;
  const visibleEvents = paginated
    ? orderedEvents.slice((page - 1) * pageSize, page * pageSize)
    : orderedEvents;
  useEffect(() => setPage(1), [events.length, pageSize]);
  if (!events.length)
    return (
      <Center mih={160}>
        <Text c="dimmed" size="sm">
          {empty}
        </Text>
      </Center>
    );
  return (
    <>
      <Stack gap={0}>
      {visibleEvents
        .map((event, index) => {
          const timestamp = event.occurredAt ?? event.createdAt;
          const millis = timestamp ? Date.parse(timestamp) : NaN;
          const displayNode = (value?: string) => {
            if (!value) return "";
            const short =
              value.split(":").at(-1)?.replace(/-\d+$/, "") ?? value;
            return (labels[short] ?? short).toUpperCase();
          };
          const from = displayNode(
            event.from ?? event.senderId ?? event.role ?? "system",
          );
          const to = displayNode(event.to ?? event.recipientIds?.join(","));
          const route = to
            ? `${from} → ${to}`
            : `${from} · ${(event.type ?? "event").replaceAll(".", " ")}`;
          return (
            <Group
              key={`${event.id ?? event.type}-${index}`}
              align="flex-start"
              wrap="nowrap"
              gap="sm"
              py="sm"
              style={{
                borderBottom: "1px solid var(--mantine-color-default-border)",
              }}
            >
              <ThemeIcon size="sm" radius="xl" variant="light">
                <IconCircleDot size={10} />
              </ThemeIcon>
              <Box style={{ flex: 1 }}>
                <Text size="xs" fw={700} c="teal">
                  {route}
                </Text>
                <Text size="sm" mt={3}>
                  {event.message ?? event.content ?? "(empty message)"}
                </Text>
              </Box>
              <Text size="xs" c="dimmed" title={timestamp ?? undefined}>
                {Number.isNaN(millis)
                  ? "—"
                  : new Date(millis).toLocaleString([], {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
              </Text>
            </Group>
          );
        })}
      </Stack>
      {paginated && totalPages > 1 && (
        <Center mt="md">
          <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
        </Center>
      )}
    </>
  );
}
function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="light"
      color={
        status === "completed"
          ? "green"
          : status === "waiting_for_human"
            ? "yellow"
            : status === "failed"
              ? "red"
              : "teal"
      }
    >
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

function MacroPlanBoard({ api, workstream, onChange }: { api: string; workstream: Workstream; onChange: (tasks: Task[]) => void }) {
  const columns = [
    { status: "ready", label: "Backlog", color: "gray" },
    { status: "assigned", label: "To Do", color: "blue" },
    { status: "running", label: "In Progress", color: "yellow" },
    { status: "review", label: "Review", color: "violet" },
  ] as const;
  const priority = (task: Task) => (task as Task & { priority?: string }).priority ?? "normal";
  return <Stack gap="md" className="macro-plan-board">
    <Group justify="space-between" align="flex-end"><div><Group gap="xs"><IconLayoutKanban size={18} /><Title order={2}>Macro Plan</Title></Group><Text size="sm" c="dimmed">A live view of the workstream’s durable task queue.</Text></div><Badge variant="dot" color="teal">{workstream.tasks.length} tasks</Badge></Group>
    <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="sm">
      {columns.map((column) => { const tasks = workstream.tasks.filter((task) => task.status === column.status); return <Stack key={column.status} gap="xs" className="macro-column">
        <Group justify="space-between" className="macro-column-header"><Group gap="xs"><Badge color={column.color} variant="light" size="sm">{tasks.length}</Badge><Text fw={700} size="sm">{column.label}</Text></Group><Text size="xs" c="dimmed" tt="uppercase">{column.status}</Text></Group>
        {tasks.length ? tasks.map((task) => <Card key={task.id} withBorder padding="sm" className="macro-task-card"><Stack gap="xs"><Group justify="space-between" align="flex-start"><Text fw={650} size="sm">{task.title}</Text><Badge size="xs" variant="outline" color={priority(task) === "high" ? "red" : "gray"}>{priority(task)}</Badge></Group><Group gap="xs"><Badge size="xs" variant="light">{task.ownerAgentId ?? "unassigned"}</Badge><Text size="xs" c="dimmed">{task.evidence.length} evidence</Text></Group><Text size="xs" c="dimmed" lineClamp={2}>{task.acceptanceCriteria[0] ?? "No acceptance criteria"}</Text></Stack></Card>) : <Card withBorder padding="md" className="macro-empty"><Text size="xs" c="dimmed">No tasks in this lane</Text></Card>}
      </Stack>; })}
    </SimpleGrid>
    <Box className="macro-task-sync"><TaskBoard api={api} workstreamId={workstream.id} tasks={workstream.tasks} onChange={onChange} /></Box>
  </Stack>;
}
function App() {
  const [items, setItems] = useState<Workstream[]>([]);
  const [selected, setSelected] = useState<Workstream | null>(null);
  const [page, setPage] = useState("Overview");
  const [focus, setFocus] = useState<string | null>(null);
  const [edgeFocus, setEdgeFocus] = useState<[string, string] | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [opened, { toggle, close }] = useDisclosure(false);
  const mobile = useMediaQuery("(max-width: 48em)");
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  useEffect(() => {
    fetch(`${api}/api/workstreams`)
      .then((r) => r.json())
      .then((data: Workstream[]) => {
        setItems(data);
        setSelected(data[0] ?? null);
      });
  }, []);
  useEffect(() => {
    if (!selected) return;
    const socket = new WebSocket(wsUrl);
    socket.onmessage = (incoming) => {
      const envelope = JSON.parse(incoming.data) as {
        workstreamId?: string;
        message?: Event;
        type?: string;
        occurredAt?: string;
      };
      const event: Event = envelope.message
        ? { ...envelope.message, type: envelope.type, occurredAt: envelope.occurredAt }
        : (envelope as Event);
      if (envelope.workstreamId === selected.id) {
        const statusByEvent: Record<string, string> = {
          "workstream.starting": "starting",
          "workstream.active": "active",
          "workstream.waiting_for_human": "waiting_for_human",
          "workstream.completed": "completed",
          "workstream.paused": "paused",
          "workstream.emergency_stopped": "emergency_stopped",
        };
        setSelected((current) => {
          if (!current) return current;
          const isMessage = Boolean(envelope.message) || (event.type?.startsWith("message.") ?? false);
          if (isMessage && event.id && current.messages?.some((message) => message.id === event.id)) return current;
          if (!isMessage && event.id && current.events.some((existing) => existing.id === event.id)) return current;
          const running = ["run.started", "run.heartbeat", "turn.started", "turn.delta", "tool.started", "tool.completed"].includes(event.type ?? "");
          const settled = ["task.completed", "task.failed", "turn.failed", "turn.cancelled"].includes(event.type ?? "");
          const agents = event.role
            ? current.agents.map((agent) => agent.role === event.role ? { ...agent, status: running ? "running" : settled ? (event.type === "task.completed" ? "done" : "failed") : agent.status } : agent)
            : current.agents;
          return {
            ...current,
            status: statusByEvent[event.type ?? ""] ?? current.status,
            agents,
            events: [...current.events, event],
            messages: isMessage ? [...(current.messages ?? []), event] : current.messages,
          };
        });
      }
    };
    return () => socket.close();
  }, [selected?.id]);
  useEffect(() => {
    const listener = (event: globalThis.Event) =>
      selectAgent(
        (event as CustomEvent<{ id?: string | null }>).detail?.id ?? null,
      );
    window.addEventListener("agentweave:agent-selected", listener);
    return () =>
      window.removeEventListener("agentweave:agent-selected", listener);
  }, []);
  const messages =
    selected?.messages ??
    selected?.events.filter((event) => event.type?.startsWith("message.")) ??
    [];
  const filtered = useMemo(
    () =>
      messages.filter((event) =>
        edgeFocus
          ? ((event.from ?? event.senderId) === edgeFocus[0] && (event.to ?? event.recipientIds?.join(","))?.includes(edgeFocus[1])) ||
            ((event.from ?? event.senderId) === edgeFocus[1] && (event.to ?? event.recipientIds?.join(","))?.includes(edgeFocus[0]))
          : focus
            ? (event.from ?? event.senderId) === focus || (event.to ?? event.recipientIds?.join(","))?.split(",").includes(focus)
            : true,
      ),
    [messages, focus, edgeFocus],
  );
  function choose(item: Workstream, next: string) {
    setSelected(item);
    setPage(next);
    setFocus(null);
    setEdgeFocus(null);
    setDraft("");
    setSendError(null);
    if (mobile) close();
  }
  function selectAgent(id: string | null) {
    if (!id || id === "human") return;
    setFocus((current) => {
      const next = current === id ? null : id;
      setDraft((currentDraft) => {
        const tag = `@${id}`;
        const withoutTag = currentDraft
          .replace(new RegExp(`${tag}\\s*`, "ig"), "")
          .trimStart();
        return next ? `${tag} ${withoutTag}` : withoutTag;
      });
      setSendError(null);
      return next;
    });
  }
  function addCreated(id: string) {
    void fetch(`${api}/api/workstreams/${id}`)
      .then((r) => r.json())
      .then((item: Workstream) => {
        setItems((current) => [
          item,
          ...current.filter((candidate) => candidate.id !== id),
        ]);
        setSelected(item);
        setCreateOpen(false);
      });
  }
  async function send() {
    if (!selected || !draft.trim()) return;
    const mentions = [...draft.matchAll(/@(pm|pe|coder|qa)\b/gi)].map((match) =>
      match[1].toLowerCase(),
    );
    const recipients = [
      ...new Set(mentions.length ? mentions : focus ? [focus] : []),
    ];
    if (!recipients.length) {
      setSendError(
        "Select an Agent or mention one with @pm, @pe, @coder, or @qa.",
      );
      return;
    }
    const content = draft.replace(/@(pm|pe|coder|qa)\b/gi, "").trim();
    try {
      const response = await fetch(
        `${api}/api/workstreams/${selected.id}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from: "human",
            recipients,
            content,
            intent: "question",
          }),
        },
      );
      if (!response.ok) throw new Error(`Message failed (${response.status})`);
      const created = (await response.json()) as Event;
      const localMessage = { ...created, type: "message.created" };
      setSelected((current) =>
        current && !current.messages?.some((message) => message.id === created.id)
          ? { ...current, messages: [...(current.messages ?? []), localMessage] }
          : current,
      );
      setFocus(recipients[0]);
      setDraft("");
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Message failed");
    }
  }
  const navigation = (
    <Stack gap={4}>
      <NavLink
        label="Overview"
        leftSection={<IconLayoutDashboard size={17} />}
        active={!selected}
        onClick={() => {
          setSelected(null);
          if (mobile) close();
        }}
      />
      {items.map((item) => (
        <Box key={item.id}>
          <NavLink
            label={item.goal}
            description={<StatusBadge status={item.status} />}
            leftSection={
              <ThemeIcon size="sm" variant="light">
                <IconBrain size={14} />
              </ThemeIcon>
            }
            rightSection={<IconChevronRight size={15} />}
            active={selected?.id === item.id && page === "Overview"}
            onClick={() => choose(item, "Overview")}
          />
          {selected?.id === item.id && (
            <Stack gap={2} ml="xl">
              {pages.slice(1).map((entry) => {
                const PageIcon = entry.icon;
                return (
                  <NavLink
                    key={entry.value}
                    label={entry.label}
                    leftSection={<PageIcon size={15} />}
                    active={page === entry.value}
                    onClick={() => choose(item, entry.value)}
                  />
                );
              })}
            </Stack>
          )}
        </Box>
      ))}
    </Stack>
  );
  const sidebar = (
    <Stack h="100%" gap="lg">
      <Group px="xs" justify="space-between">
        <div>
          <Text fw={800} size="lg">
            AgentWeave
          </Text>
          <Text size="xs" c="dimmed">
            control plane
          </Text>
        </div>
        {mobile && (
          <Button variant="subtle" onClick={close}>
            Close
          </Button>
        )}
      </Group>
      <Button
        variant="light"
        leftSection={<IconPlus size={16} />}
        onClick={() => setCreateOpen(true)}
      >
        New Workstream
      </Button>
      <ScrollArea.Autosize mah="calc(100vh - 220px)">
        {navigation}
      </ScrollArea.Autosize>
      <Box mt="auto">
        <Divider mb="sm" />
        <Group gap="xs">
          <IconCircleDot size={14} color="var(--mantine-color-green-6)" />
          <Text size="xs" c="dimmed">
            Local runtime online
          </Text>
        </Group>
      </Box>
    </Stack>
  );
  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 280, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="lg" justify="space-between">
          <Group>
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
            />
            <Text fw={800} hiddenFrom="sm">
              AgentWeave
            </Text>
          </Group>
          <Group gap="sm">
            <Badge
              variant="light"
              leftSection={<IconArrowsExchange size={12} />}
            >
              Docker runtime
            </Badge>
            <Tooltip
              label={colorScheme === "dark" ? "Light mode" : "Dark mode"}
            >
              <Button
                variant="subtle"
                size="compact-sm"
                onClick={() => toggleColorScheme()}
              >
                {colorScheme === "dark" ? (
                  <IconSun size={17} />
                ) : (
                  <IconMoon size={17} />
                )}
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">{sidebar}</AppShell.Navbar>
      <AppShell.Main>
        <Box maw={1400} mx="auto">
          <Group justify="space-between" mb="xl">
            <div>
              <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
                {selected?.flavor ?? "Agent network"}
              </Text>
              <Title order={1}>{selected ? page : "Workstreams"}</Title>
            </div>
            {selected && <StatusBadge status={selected.status} />}
          </Group>
          {!selected ? (
            <Paper withBorder radius="lg" p={{ base: "xl", sm: 60 }}>
              <Stack align="flex-start" maw={650}>
                <ThemeIcon size={52} radius="md" variant="light">
                  <IconTopologyStar3 size={28} />
                </ThemeIcon>
                <Title order={2}>Operate your agent network.</Title>
                <Text c="dimmed">
                  Select a Workstream to inspect durable tasks, live Agent Hive
                  messages, evidence, and runtime activity.
                </Text>
                <Button
                  leftSection={<IconPlus size={16} />}
                  onClick={() => setCreateOpen(true)}
                >
                  Create your first Workstream
                </Button>
                <WorkstreamControls
                  api={api}
                  workstreamId=""
                  status="completed"
                  onStatus={() => undefined}
                  onCreated={addCreated}
                  openCreate={createOpen}
                  onCreateOpenChange={setCreateOpen}
                  createOnly
                />
              </Stack>
            </Paper>
          ) : (
            <Stack gap="lg">
              <Paper withBorder radius="lg" p="lg">
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  {selected.flavor}
                </Text>
                <Title order={2} mt={4}>
                  {selected.goal}
                </Title>
                <Text size="xs" c="dimmed" mt={6}>
                  Workspace · {selected.workspaceRoot}
                </Text>
                <WorkstreamControls
                  api={api}
                  workstreamId={selected.id}
                  status={selected.status}
                  onStatus={(status) => setSelected({ ...selected, status })}
                  onCreated={addCreated}
                  openCreate={createOpen}
                  onCreateOpenChange={setCreateOpen}
                />
              </Paper>
              {page === "Overview" && (
                <Stack gap="lg">
                  <RunConsole status={selected.status} provider={selected.provider} events={selected.events} />
                  <Paper withBorder radius="lg" p="lg">
                    <AgentExecutionPanel agents={selected.agents} events={selected.events} />
                  </Paper>
                  <MacroPlanBoard api={api} workstream={selected} onChange={(tasks) => setSelected({ ...selected, tasks })} />
                  <Paper withBorder radius="lg" p="lg">
                    <SummaryReport
                      status={selected.status}
                      tasks={selected.tasks}
                      agents={selected.agents}
                      messages={messages}
                      events={selected.events}
                    />
                  </Paper>
                </Stack>
              )}
              {page === "Tasks" && (
                <Paper withBorder radius="lg" p="lg">
                  <Group justify="space-between" mb="lg">
                    <Title order={3}>Task board</Title>
                    <IconCheck size={20} />
                  </Group>
                  <TaskBoard
                    api={api}
                    workstreamId={selected.id}
                    tasks={selected.tasks}
                    onChange={(tasks) => setSelected({ ...selected, tasks })}
                  />
                </Paper>
              )}
              {page === "Activity" && (
                <Paper withBorder radius="lg" p="lg">
                  <Group justify="space-between" mb="lg">
                    <Title order={3}>Activity stream</Title>
                    <Badge variant="light">
                      {selected.events.length} events
                    </Badge>
                  </Group>
                  <MessageList events={selected.events} paginated pageSize={10} />
                </Paper>
              )}
              {page === "Agent hive" && (
                <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="lg">
                  <Stack>
                    <Paper withBorder radius="lg" p="lg">
                      <Group justify="space-between" mb="md">
                        <Title order={3}>Agent Hive topology</Title>
                        <SegmentedControl
                          size="xs"
                          value={focus ?? "all"}
                          onChange={(value) => {
                            setFocus(value === "all" ? null : value);
                            setEdgeFocus(null);
                          }}
                          data={[
                            { label: "All", value: "all" },
                            ...["pm", "pe", "coder", "qa"].map((value) => ({
                              label: value.toUpperCase(),
                              value,
                            })),
                          ]}
                        />
                      </Group>
                      <AgentHiveGraph
                        selected={focus}
                        onSelect={setFocus}
                        onEdgeSelect={(source, target) => {
                          setEdgeFocus([source, target]);
                          setFocus(null);
                        }}
                      />
                    </Paper>
                    <LiveMessageBus messages={messages} agents={selected.agents} />
                  </Stack>
                  <Card withBorder radius="lg">
                    <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
                      Human conversation
                    </Text>
                    <Title order={3} mt="xs">
                      {focus ? labels[focus] : "Select an Agent"}
                    </Title>
                    <Text size="sm" c="dimmed">
                      Only Human ↔ Agent chat appears here.
                    </Text>
                    <MessageList
                      events={filtered.filter(
                        (event) =>
                          (event.from ?? event.senderId) === "human" ||
                          (event.to ?? event.recipientIds?.join(","))?.includes("human"),
                      )}
                      empty="No direct conversation yet"
                    />
                    <Divider my="md" />
                    <Textarea
                      label="Send a message"
                      description="Mention an agent, e.g. @pm"
                      value={draft}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      minRows={4}
                    />
                    <Button
                      mt="sm"
                      fullWidth
                      leftSection={<IconMessage size={16} />}
                      onClick={() => void send()}
                    >
                      Send message
                    </Button>
                  </Card>
                </SimpleGrid>
              )}
            </Stack>
          )}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider defaultColorScheme="light">
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
