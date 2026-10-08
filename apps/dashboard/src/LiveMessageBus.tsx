import {
  Badge,
  Button,
  Center,
  Group,
  ScrollArea,
  Select,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { IconMessages } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roleColor, roleIcon, roleLabel, type TemplateRoleVisual } from "./roleVisuals";
import { SteerComposer, type SteerRole } from "./SteerComposer";
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
  /** Legacy composer bindings (kept for compatibility; the timeline now uses SteerComposer). */
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** Called with the composed steer text. */
  onSend: (text?: string) => void;
  sendError: string | null;
  templateRoles?: readonly TemplateRoleVisual[];
};

function stripPromptPrefix(content: string): string {
  return content.replace(/\[agentweave[^\]]*\]\s*/g, "");
}

function roleIdFor(authorId: string | undefined, agents: Agent[]): string | undefined {
  if (!authorId || authorId === "human") return undefined;
  const agent = agents.find((candidate) => candidate.id === authorId);
  if (agent) return agent.role;
  const short = authorId.split(":").at(-1)?.replace(/-\d+$/, "");
  return short;
}

function eventTag(kind: string, category: string, isHuman: boolean): { label: string; tone: string } {
  if (isHuman) return { label: "Human steer", tone: "human" };
  if (kind === "insight") {
    const label = category.toUpperCase();
    const tone = category === "proposal" ? "proposal" : category === "critique" ? "critique" : category === "synthesis" ? "synthesis" : "insight";
    return { label, tone };
  }
  const lower = category.toLowerCase();
  if (lower.includes("token") || lower.includes("usage")) return { label: "Tokens", tone: "token" };
  if (lower.includes("propos")) return { label: "Propose", tone: "proposal" };
  if (lower.includes("crit")) return { label: "Critique", tone: "critique" };
  if (lower.includes("rebut")) return { label: "Rebuttal", tone: "rebuttal" };
  if (lower.includes("synth")) return { label: "Synthesis", tone: "synthesis" };
  return { label: category.replaceAll(".", " ").replaceAll("_", " "), tone: "message" };
}

export function LiveMessageBus({ messages, insights = [], agents, onSend, sendError, templateRoles }: Props) {
  const [agentFilter, setAgentFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const agentOptions = [
    { value: "all", label: "All agents" },
    { value: "human", label: "Human" },
    ...agents.map((agent) => ({ value: agent.id, label: agent.role.toUpperCase() })),
  ];
  const typeOptions = [
    { value: "all", label: "All event types" },
    ...[...new Set([...messages.map((message) => message.messageType ?? message.type), ...insights.map((insight) => insight.kind)].filter(Boolean))].map((type) => ({ value: type!, label: type!.replaceAll(".", " ") })),
  ];

  const visible = useMemo(
    () =>
      unifiedStream(messages, insights).filter(
        (item) =>
          (agentFilter === "all" || item.authorId === agentFilter || item.recipientIds.includes(agentFilter)) &&
          (typeFilter === "all" || item.category === typeFilter),
      ),
    [messages, insights, agentFilter, typeFilter],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport && stickToBottom.current) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible, agentFilter, typeFilter]);

  const steerRoles: SteerRole[] = useMemo(
    () => agents.map((agent) => ({ id: agent.role, label: roleLabel(agent.role, templateRoles) })),
    [agents, templateRoles],
  );

  return (
    <div className="cc-panel cc-live-events">
      <Group justify="space-between" align="flex-start" mb="sm">
        <div>
          <Group gap="xs">
            <span className="cc-live-dot" aria-hidden />
            <Text fw={800}>Live events</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={3}>Every proposal, critique, steer, and token burn — as it happens.</Text>
        </div>
        <Group gap="xs">
          <Button size="compact-xs" variant="subtle" onClick={() => setFiltersOpen((o) => !o)}>
            {filtersOpen ? "Hide filters" : "Filters"}
          </Button>
          <Badge variant="light" color="teal">{visible.length} events</Badge>
        </Group>
      </Group>
      {filtersOpen && (
        <Group grow mb="sm">
          <Select aria-label="Filter events by agent" value={agentFilter} onChange={(value) => setAgentFilter(value ?? "all")} data={agentOptions} allowDeselect={false} size="xs" />
          <Select aria-label="Filter events by type" value={typeFilter} onChange={(value) => setTypeFilter(value ?? "all")} data={typeOptions} allowDeselect={false} size="xs" />
        </Group>
      )}
      {!visible.length ? (
        <Center mih={180}>
          <Stack align="center" gap="xs">
            <ThemeIcon variant="light" radius="xl"><IconMessages size={16} /></ThemeIcon>
            <Text size="sm" c="dimmed">No events yet — start the workstream and watch it unfold.</Text>
          </Stack>
        </Center>
      ) : (
        <ScrollArea
          className="bus-scroll-area cc-timeline-scroll"
          type="auto"
          offsetScrollbars
          viewportRef={viewportRef}
          onScrollPositionChange={() => {
            const viewport = viewportRef.current;
            if (viewport) stickToBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
          }}
        >
          <div className="cc-timeline">
            {visible.map((item, index) => {
              const isHuman = item.authorId === "human";
              const roleId = roleIdFor(item.authorId, agents);
              const color = isHuman ? "#38bdf8" : roleColor(roleId ?? item.authorId ?? "system", templateRoles);
              const icon = isHuman ? "🧑" : roleIcon(roleId ?? "", templateRoles);
              const label = isHuman ? "You" : roleLabel(roleId ?? item.authorId ?? "system", templateRoles);
              const tag = eventTag(item.kind, item.category, isHuman);
              const neighbors = item.kind === "insight" ? causalNeighbors(item.id, insights) : undefined;
              return (
                <div
                  key={item.id ?? `${item.authorId}-${item.createdAt}-${index}`}
                  id={`stream-${item.id}`}
                  className={`cc-event cc-event-tone-${tag.tone}${isHuman ? " cc-event-human" : ""}`}
                >
                  <span className="cc-event-dot" aria-hidden />
                  <AgentAvatar color={color} icon={icon} state="idle" size={32} />
                  <div className="cc-event-body">
                    <Group gap="xs" mb={4} wrap="wrap">
                      <Text size="sm" fw={800}>{label}</Text>
                      <span className={`cc-tag cc-tag-${tag.tone}`}>{tag.label}</span>
                      <Text size="xs" c="dimmed">
                        {item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}
                      </Text>
                    </Group>
                    <Text size="sm" className="cc-event-content">
                      {stripPromptPrefix(item.content || "") || "(empty message)"}
                    </Text>
                    {(item.taskId || item.correlationId || neighbors) && (
                      <Group gap="xs" mt={6}>
                        {item.taskId && <Text size="xs" c="dimmed">Task · {item.taskId.slice(-8)}</Text>}
                        {item.correlationId && <Text size="xs" c="dimmed">Trace · {item.correlationId.slice(0, 8)}</Text>}
                        {neighbors && [...neighbors.supporting, ...neighbors.opposing].map((related) => (
                          <Button
                            key={related.id}
                            variant="subtle"
                            size="compact-xs"
                            color={neighbors.opposing.includes(related) ? "red" : "blue"}
                            onClick={() => document.getElementById(`stream-${related.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                          >
                            {neighbors.opposing.includes(related) ? "Opposes" : "Supports"} · {related.id.slice(-8)}
                          </Button>
                        ))}
                      </Group>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
      <div className="cc-composer-wrap">
        <SteerComposer roles={steerRoles} onSubmit={(text) => onSend(text)} error={sendError} />
      </div>
    </div>
  );
}
