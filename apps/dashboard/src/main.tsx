import "@mantine/core/styles.css";
import "@xyflow/react/dist/style.css";
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Center,
  Divider,
  Group,
  MantineProvider,
  Modal,
  NavLink,
  Paper,
  Pagination,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
  IconActivity,
  IconBrain,
  IconChevronRight,
  IconCircleDot,
  IconMoon,
  IconPlus,
  IconSun,
  IconTopologyStar3,
} from "@tabler/icons-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentsNow, type SteerMessage } from "./AgentsNow";
import { GoalBar } from "./GoalBar";
import { SessionTotals } from "./SessionTotals";
import { computeAgentCards } from "./agentCards";
import { TaskBoard, type Task } from "./TaskBoard";
import { WorkstreamControls } from "./WorkstreamControls";
import { LiveMessageBus } from "./LiveMessageBus";
import { TemplateManager } from "./TemplateManager";
import { providerModelLabel } from "./providerDisplay";
import type { StreamInsight } from "./unified-stream";
import "./styles.css";

const api =
  import.meta.env.VITE_CONTROL_API_URL ??
  `${window.location.protocol}//${window.location.hostname}:3000`;
const wsUrl =
  import.meta.env.VITE_CONTROL_WS_URL ??
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:3000/events`;
type Event = {
  id?: string;
  sequence?: number;
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
  correlationId?: string;
  role?: string;
  from?: string;
  to?: string;
  occurredAt?: string;
  createdAt?: string;
};
type Agent = { id: string; role: string; authority: string; status: string };
type RuntimeAgent = { agentId: string; role: string; status: string; activity: string; waitingReason?: string; providerState: "healthy" | "degraded" | "unavailable"; lastSignalAt?: string; stale: boolean; latencyMs?: number; usage: { source: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number } };
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
  template?: { id: string; name: string; roles: Array<{ id: string; label: string; color?: string; icon?: string }>; taskLanes: Array<{ status: string; label: string; color: string }> };
  insights?: StreamInsight[];
  runtime?: { generatedAt: string; status: string; headline: string; activeAgents: number; degradedAgents: number; lastActivityAt?: string; agents: RuntimeAgent[] };
};
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

function App() {
  const [items, setItems] = useState<Workstream[]>([]);
  const [selected, setSelected] = useState<Workstream | null>(null);
  const [auditOpen, { open: openAudit, close: closeAudit }] = useDisclosure(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [opened, { toggle, close }] = useDisclosure(false);
  const [workstreamsOpen, { toggle: toggleWorkstreams, close: closeWorkstreams }] = useDisclosure(false);
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
    const selectedId = selected.id;
    let lastSequence = Math.max(0, ...selected.events.map((event) => event.sequence ?? 0));
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 500;
    let disposed = false;
    const syncSnapshot = async () => {
      const [response, insightResponse] = await Promise.all([fetch(`${api}/api/workstreams/${selectedId}/snapshot`).catch(() => undefined), fetch(`${api}/api/workstreams/${selectedId}/insights`).catch(() => undefined)]);
      if (!response?.ok) return;
      const snapshot = await response.json() as { schemaVersion: number; cursor: number; workstream: Workstream; runtime?: Workstream["runtime"] };
      if (snapshot.schemaVersion !== 1 || !snapshot.workstream) return;
      lastSequence = Math.max(lastSequence, snapshot.cursor);
      const insightProjection = insightResponse?.ok ? await insightResponse.json() as { insights?: StreamInsight[] } : undefined;
      const updated = {
        ...snapshot.workstream,
        insights: insightProjection?.insights ?? [],
        ...(snapshot.runtime ? { runtime: snapshot.runtime } : {}),
      };
      setSelected((current) => current?.id === selectedId ? updated : current);
      setItems((current) => current.map((item) => item.id === selectedId ? updated : item));
    };
    const handleMessage = (incoming: MessageEvent<string>) => {
      const envelope = JSON.parse(incoming.data) as {
        workstreamId?: string;
        message?: Event | string;
        type?: string;
        occurredAt?: string;
      };
      const durableMessage =
        envelope.message && typeof envelope.message === "object"
          ? envelope.message
          : undefined;
      const event: Event = durableMessage
        ? { ...durableMessage, type: envelope.type, occurredAt: envelope.occurredAt }
        : (envelope as Event);
      if (envelope.workstreamId === selectedId) {
        const sequence = Number(event.sequence ?? 0);
        if (sequence > 0 && sequence > lastSequence + 1) {
          void syncSnapshot();
          return;
        }
        if (sequence > 0) lastSequence = Math.max(lastSequence, sequence);
        // Workflow events invalidate the projection; domain state always comes from the server snapshot.
        void syncSnapshot();
      }
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${wsUrl}?workstreamId=${encodeURIComponent(selectedId)}&afterSequence=${lastSequence}`);
      socket.onopen = () => {
        reconnectDelay = 500;
        void syncSnapshot();
      };
      socket.onmessage = handleMessage;
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [selected?.id]);
  const messages =
    selected?.messages ??
    selected?.events.filter((event) => event.type?.startsWith("message.")) ??
    [];
  const agentCards = useMemo(
    () => (selected ? computeAgentCards(selected.agents, selected.events, selected.runtime) : []),
    [selected],
  );
  const humanSteers = useMemo<SteerMessage[]>(
    () =>
      messages
        .filter((message) => message.from === "human" || message.senderId === "human")
        .map((message) => ({
          id: message.id,
          content: message.content,
          message: message.message,
          createdAt: message.createdAt,
          occurredAt: message.occurredAt,
        })),
    [messages],
  );
  function choose(item: Workstream) {
    setSelected(item);
    setSendError(null);
    if (immersiveOverview) closeWorkstreams();
    if (mobile) close();
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
  async function send(overrideText?: string) {
    const text = (overrideText ?? "").trim();
    if (!selected || !text) return;
    const agentRoles = new Set(selected.agents.map((agent) => agent.role.toLowerCase()));
    const mentions = [...text.matchAll(/@([a-z][a-z0-9_-]*)\b/gi)]
      .map((match) => match[1].toLowerCase())
      .filter((role) => agentRoles.has(role));
    const recipients = [
      ...new Set(mentions),
    ];
    if (!recipients.length) {
      setSendError(
        "Mention one or more roles with @, for example @pm or @backend.",
      );
      return;
    }
    const content = text.replace(/@[a-z][a-z0-9_-]*\b/gi, "").trim();
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
      setSendError(null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Message failed");
    }
  }
  const navigation = (
    <Stack gap={4}>
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
            active={selected?.id === item.id}
            onClick={() => choose(item)}
          />
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
  const immersiveOverview = Boolean(selected);
  return (
    <AppShell
      header={{ height: immersiveOverview ? 48 : 64 }}
      navbar={{ width: 280, breakpoint: "sm", collapsed: { mobile: !opened, desktop: immersiveOverview ? !workstreamsOpen : false } }}
      padding={immersiveOverview ? "xs" : "lg"}
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
            <Text fw={800}>
              AgentWeave
            </Text>
            {immersiveOverview && (
              <Tooltip label="Workstreams">
                <Burger opened={workstreamsOpen} onClick={toggleWorkstreams} aria-label="Toggle Workstreams" size="sm" />
              </Tooltip>
            )}
            {immersiveOverview && <Badge size="xs" color="teal" variant="light">System active</Badge>}
          </Group>
          <Group gap="sm">
            {immersiveOverview && (
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreateOpen(true)}>
                New Workstream
              </Button>
            )}
            {immersiveOverview && <Text size="xs" fw={700}>Provider: {selected?.provider.tool === "mock" ? "Demo mode" : `${selected?.provider.tool} · ${selected ? providerModelLabel(selected.provider.model) : "—"}`}</Text>}
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
        <Box maw={immersiveOverview ? "none" : 1400} mx="auto" className={immersiveOverview ? "immersive-workspace" : undefined}>
          {!immersiveOverview && <Group justify="space-between" mb="xl">
            <div>
              <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
                {selected?.flavor ?? "Agent network"}
              </Text>
              <Title order={1}>{selected ? "Overview" : "Workstreams"}</Title>
            </div>
            {selected && <StatusBadge status={selected.status} />}
          </Group>}
          {!selected ? (
            <Stack gap="xl">
            <Paper withBorder radius="lg" p={{ base: "xl", sm: 60 }}>
              <Stack align="flex-start" maw={650}>
                <ThemeIcon size={52} radius="md" variant="light">
                  <IconTopologyStar3 size={28} />
                </ThemeIcon>
                <Title order={2}>Operate your agent network.</Title>
                <Text c="dimmed">
                  Select a Workstream to inspect durable tasks, live agent
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
            <Paper withBorder radius="lg" p={{ base: "xl", sm: 40 }}>
              <TemplateManager api={api} />
            </Paper>
            </Stack>
          ) : (
            <Stack gap="lg" className="cc-workspace">
              <GoalBar
                goal={selected.goal}
                tasks={selected.tasks}
                workstreams={items.map((item) => ({ id: item.id, goal: item.goal, status: item.status }))}
                selectedId={selected.id}
                onSelect={(id) => {
                  const item = items.find((candidate) => candidate.id === id);
                  if (item) choose(item);
                }}
                controls={
                  <>
                    <Button size="xs" variant="light" leftSection={<IconActivity size={14} />} onClick={openAudit}>Audit log</Button>
                    <WorkstreamControls
                      api={api}
                      workstreamId={selected.id}
                      status={selected.status}
                      onStatus={(status) =>
                        setSelected((current) =>
                          current?.id === selected.id ? { ...current, status } : current,
                        )
                      }
                      onCreated={addCreated}
                      openCreate={createOpen}
                      onCreateOpenChange={setCreateOpen}
                    />
                  </>
                }
              />
              <div className="cc-grid">
                <AgentsNow
                  cards={agentCards}
                  templateRoles={selected.template?.roles}
                  steers={humanSteers}
                />
                <LiveMessageBus
                  messages={messages}
                  insights={selected.insights ?? []}
                  agents={selected.agents}
                  onSend={(text) => void send(text)}
                  sendError={sendError}
                  templateRoles={selected.template?.roles}
                />
                <SessionTotals
                  cards={agentCards}
                  templateRoles={selected.template?.roles}
                />
              </div>
              <TaskBoard
                tasks={selected.tasks}
                lanes={selected.template?.taskLanes}
                agents={selected.agents}
              />
              <Modal opened={auditOpen} onClose={closeAudit} title={<Group gap="sm"><Text fw={800} size="lg">Audit log</Text><Badge variant="light">{selected.events.length} events</Badge></Group>} size="xl" centered>
                <Text size="sm" c="dimmed" mb="md">System lifecycle, task, tool, retry, and Human-control events.</Text>
                <ScrollArea h="65vh" type="auto">
                  <Box pr="md"><MessageList events={selected.events} paginated pageSize={10} /></Box>
                </ScrollArea>
              </Modal>
            </Stack>
          )}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
