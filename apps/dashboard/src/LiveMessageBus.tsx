import {
  Badge,
  Button,
  Box,
  Combobox,
  Center,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Textarea,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { IconArrowsExchange, IconMessage, IconMessages } from "@tabler/icons-react";
import { useCombobox } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { causalNeighbors, unifiedStream, type StreamInsight } from "./unified-stream";

export type BusMessage = {
  id?: string;
  type?: string;
  senderId?: string;
  recipientIds?: string[];
  from?: string;
  to?: string;
  messageType?: string;
  taskId?: string;
  correlationId?: string;
  content?: string;
  message?: string;
  createdAt?: string;
  occurredAt?: string;
};

type Agent = { id: string; role: string };
type Props = {
  messages: BusMessage[];
  insights?: StreamInsight[];
  agents: Agent[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  sendError: string | null;
};

function displayAgent(value: string | undefined, agents: Agent[]): string {
  if (!value) return "SYSTEM";
  if (value === "human") return "HUMAN";
  const agent = agents.find((candidate) => candidate.id === value);
  if (agent) return agent.role.toUpperCase();
  const short = value.split(":").at(-1)?.replace(/-\d+$/, "") ?? value;
  return short.toUpperCase();
}

export function LiveMessageBus({ messages, insights = [], agents, draft, onDraftChange, onSend, sendError }: Props) {
  const [agentFilter, setAgentFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [mode, setMode] = useState("all");
  const [mentionQuery, setMentionQuery] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
    onDropdownOpen: () => combobox.selectFirstOption(),
  });
  const agentOptions = [
    { value: "all", label: "All agents" },
    { value: "human", label: "Human" },
    ...agents.map((agent) => ({ value: agent.id, label: agent.role.toUpperCase() })),
  ];
  const typeOptions = [
    { value: "all", label: "All message types" },
    ...[...new Set([...messages.map((message) => message.messageType ?? message.type), ...insights.map((insight) => insight.kind)].filter(Boolean))].map((type) => ({ value: type!, label: type!.replaceAll(".", " ") })),
  ];
  const mentionOptions = [...new Set(agents.map((agent) => agent.role.toLowerCase()))]
    .filter((role) => role.includes(mentionQuery.toLowerCase()))
    .map((role) => (
      <Combobox.Option value={role} key={role}>
        <Group gap="xs"><Text fw={700}>@{role}</Text><Text size="xs" c="dimmed">Send to {role.toUpperCase()}</Text></Group>
      </Combobox.Option>
    ));
  const visible = useMemo(
    () =>
      unifiedStream(messages, insights).filter((item) => (mode === "all" || item.kind === mode) && (agentFilter === "all" || item.authorId === agentFilter || item.recipientIds.includes(agentFilter)) && (typeFilter === "all" || item.category === typeFilter)),
    [messages, insights, mode, agentFilter, typeFilter],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport && stickToBottom.current) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible, agentFilter, typeFilter]);

  return (
    <Paper withBorder radius="lg" p="lg" className="live-message-bus">
      <Group justify="space-between" align="flex-start" mb="md">
        <div>
          <Group gap="xs">
            <ThemeIcon size="sm" variant="light" color="teal"><IconArrowsExchange size={13} /></ThemeIcon>
            <Text fw={800}>Live message bus</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={3}>Durable Human ↔ Agent and Agent ↔ Agent messages.</Text>
        </div>
        <Badge variant="light" color="teal">● live · {visible.length}</Badge>
      </Group>
      <Group grow mb="md">
        <Select aria-label="Choose stream mode" value={mode} onChange={(value) => setMode(value ?? "all")} data={[{ value: "all", label: "Messages + insights" }, { value: "message", label: "Messages" }, { value: "insight", label: "Insights" }]} allowDeselect={false} size="xs" />
        <Select aria-label="Filter messages by agent" value={agentFilter} onChange={(value) => setAgentFilter(value ?? "all")} data={agentOptions} allowDeselect={false} size="xs" />
        <Select aria-label="Filter messages by type" value={typeFilter} onChange={(value) => setTypeFilter(value ?? "all")} data={typeOptions} allowDeselect={false} size="xs" />
      </Group>
      {!visible.length ? (
        <Center mih={180}><Stack align="center" gap="xs"><ThemeIcon variant="light" radius="xl"><IconMessages size={16} /></ThemeIcon><Text size="sm" c="dimmed">No matching messages yet.</Text></Stack></Center>
      ) : (
        <ScrollArea
          className="bus-scroll-area"
          type="auto"
          offsetScrollbars
          viewportRef={viewportRef}
          onScrollPositionChange={() => { const viewport = viewportRef.current; if (viewport) stickToBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48; }}
        >
          <Stack gap={0}>
            {visible.map((item, index) => {
              const sender = item.authorId;
              const recipients = item.recipientIds;
              const createdAt = item.createdAt;
              const addressedToHuman = recipients.includes("human") || /@human\b/i.test(item.content);
              const neighbors = item.kind === "insight" ? causalNeighbors(item.id, insights) : undefined;
              return <Box id={`stream-${item.id}`} key={item.id ?? `${sender}-${createdAt}-${index}`} className={`bus-message${addressedToHuman ? " bus-message-to-human" : ""}`}>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
                  <Group gap="xs" wrap="wrap"><Text size="xs" fw={800} c={addressedToHuman ? "pink" : item.kind === "insight" ? "violet" : "teal"}>{displayAgent(sender, agents)}{item.kind === "message" ? ` → ${recipients.map((recipient) => displayAgent(recipient, agents)).join(", ") || "UNROUTED"}` : " · INSIGHT"}</Text>{addressedToHuman && <Badge size="xs" color="pink">@ HUMAN</Badge>}<Badge size="xs" variant="outline">{item.category.replaceAll(".", " ")}</Badge>{item.lifecycle && <Badge size="xs" variant="light">{item.lifecycle}</Badge>}</Group>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>{createdAt ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</Text>
                </Group>
                <Text size="sm" mt={5} className="bus-message-content">{item.content || "(empty message)"}</Text>
                {(item.taskId || item.correlationId || neighbors) && <Group gap="xs" mt={7}><Text size="xs" c="dimmed">{item.taskId ? `Task · ${item.taskId.slice(-8)}` : ""}</Text>{item.correlationId && <Text size="xs" c="dimmed">Trace · {item.correlationId.slice(0, 8)}</Text>}{neighbors && [...neighbors.supporting, ...neighbors.opposing].map((related) => <Button key={related.id} variant="subtle" size="compact-xs" color={neighbors.opposing.includes(related) ? "red" : "blue"} onClick={() => document.getElementById(`stream-${related.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{neighbors.opposing.includes(related) ? "Opposes" : "Supports"} · {related.id.slice(-8)}</Button>)}</Group>}
              </Box>;
            })}
          </Stack>
        </ScrollArea>
      )}
      <div className="bus-composer">
        <Combobox
          store={combobox}
          onOptionSubmit={(role) => {
            onDraftChange(draft.replace(/@[a-z0-9_-]*$/i, `@${role} `));
            setMentionQuery("");
            combobox.closeDropdown();
          }}
        >
          <Combobox.Target>
            <Textarea
              label="Send a message"
              description="Type @ to choose roles. Message type is inferred automatically. Slash commands remain available as an optional override."
              value={draft}
              onChange={(event) => {
                const next = event.currentTarget.value;
                onDraftChange(next);
                const mention = next.match(/@([a-z0-9_-]*)$/i);
                if (mention) {
                  setMentionQuery(mention[1]);
                  combobox.openDropdown();
                  combobox.updateSelectedOptionIndex();
                } else {
                  setMentionQuery("");
                  combobox.closeDropdown();
                }
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  combobox.closeDropdown();
                  onSend();
                }
              }}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              minRows={3}
            />
          </Combobox.Target>
          <Combobox.Dropdown>
            <Combobox.Options>{mentionOptions.length ? mentionOptions : <Combobox.Empty>No matching role</Combobox.Empty>}</Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>
        {sendError && <Text size="xs" c="red">{sendError}</Text>}
        <Text size="xs" c="dimmed" ta="right">⌘ Enter / Ctrl Enter to send</Text>
        <Button fullWidth leftSection={<IconMessage size={16} />} onClick={onSend}>Send message</Button>
      </div>
    </Paper>
  );
}
