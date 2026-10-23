import { Stack, Text } from "@mantine/core";
import type { AgentCard } from "./agentCards";
import { roleColor, roleLabel, type TemplateRoleVisual } from "./roleVisuals";
import { TokenDonutChart } from "./TokenDonutChart";

type Props = {
  cards: AgentCard[];
  templateRoles?: readonly TemplateRoleVisual[];
};

/** Right rail: session token totals with the per-agent donut. */
export function SessionTotals({ cards, templateRoles }: Props) {
  const total = cards.reduce((sum, card) => sum + card.usage.totalTokens, 0);
  if (total === 0) {
    // Nothing reported: a one-line panel instead of a full column of zeros.
    return (
      <div className="cc-panel cc-session-totals cc-session-totals-empty">
        <Text className="cc-kicker">Session totals</Text>
        <Text size="xs" c="dimmed">
          No token usage reported yet. Providers that bill in credits (e.g. Kiro) do not report token counts.
        </Text>
      </div>
    );
  }
  const data = cards.map((card) => ({
    role: roleLabel(card.role, templateRoles),
    inputTokens: card.usage.inputTokens,
    outputTokens: card.usage.outputTokens,
    totalTokens: card.usage.totalTokens,
    color: roleColor(card.role, templateRoles),
  }));

  return (
    <div className="cc-panel cc-session-totals">
      <Text className="cc-kicker">Session totals</Text>
      <div className="cc-big-number" aria-label={`${total.toLocaleString()} total tokens`}>
        {total.toLocaleString()}
      </div>
      <Text size="xs" c="dimmed" mb="md">
        tokens this workstream
      </Text>
      <Stack align="center">
        <TokenDonutChart data={data} />
      </Stack>
    </div>
  );
}
