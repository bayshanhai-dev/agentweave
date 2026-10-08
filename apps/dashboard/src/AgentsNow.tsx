import { Badge, Text } from "@mantine/core";
import { AgentAvatar, type AvatarState } from "./AgentAvatar";
import type { AgentCard } from "./agentCards";
import { roleColor, roleIcon, roleLabel, type TemplateRoleVisual } from "./roleVisuals";

export type SteerMessage = {
  id?: string;
  content?: string;
  message?: string;
  createdAt?: string;
  occurredAt?: string;
};

type Props = {
  cards: AgentCard[];
  templateRoles?: readonly TemplateRoleVisual[];
  steers: SteerMessage[];
};

function avatarState(status: AgentCard["status"]): AvatarState {
  return status === "running" ? "working" : "idle";
}

function statusBadge(status: AgentCard["status"]) {
  if (status === "running") return <Badge size="xs" color="yellow" variant="filled">Working</Badge>;
  if (status === "failed") return <Badge size="xs" color="red" variant="filled">Failed</Badge>;
  return <Badge size="xs" color="gray" variant="light">Idle</Badge>;
}

function relativeTime(value?: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Left rail: what every agent is doing right now, plus human steer history. */
export function AgentsNow({ cards, templateRoles, steers }: Props) {
  const recent = steers.slice(-3).reverse();
  return (
    <div className="cc-panel cc-agents-now">
      <Text className="cc-kicker">Agents now</Text>
      <div className="cc-agent-list">
        {cards.map((card) => {
          const color = roleColor(card.role, templateRoles);
          const icon = roleIcon(card.role, templateRoles);
          const working = card.status === "running";
          return (
            <div
              key={card.agent.id}
              className={`cc-agent-card${working ? " cc-agent-working" : ""}`}
            >
              <AgentAvatar color={color} icon={icon} state={avatarState(card.status)} size={40} />
              <div className="cc-agent-meta">
                <div className="cc-agent-head">
                  <Text size="sm" fw={800} className="cc-agent-role">
                    {roleLabel(card.role, templateRoles)}
                  </Text>
                  {statusBadge(card.status)}
                </div>
                <Text size="xs" c="dimmed" className="cc-agent-activity">
                  {card.activity}
                  {working ? <span className="av-typing" aria-hidden><i /><i /><i /></span> : null}
                </Text>
                <Text size="xs" c="dimmed">
                  {card.usage.totalTokens > 0
                    ? `${card.usage.totalTokens.toLocaleString()} tok`
                    : "no tokens yet"}
                  {card.stale ? " · stale" : ""}
                </Text>
              </div>
            </div>
          );
        })}
      </div>
      <div className="cc-steer-history">
        <Text className="cc-kicker cc-steer-kicker">◉ Human steer</Text>
        {recent.length ? (
          recent.map((steer, index) => (
            <Text key={steer.id ?? index} size="xs" c="dimmed" className="cc-steer-item">
              “{(steer.content ?? steer.message ?? "").slice(0, 120)}”
              <span className="cc-steer-time">{relativeTime(steer.createdAt ?? steer.occurredAt)}</span>
            </Text>
          ))
        ) : (
          <Text size="xs" c="dimmed">No steers yet — tag agents with @ to direct them.</Text>
        )}
      </div>
    </div>
  );
}
