import { Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconHandStop } from "@tabler/icons-react";
import { useState } from "react";
import { parseStructuredContent } from "./unified-stream";

type TaskLike = { title?: string };
type EventLike = { type?: string; message?: string; content?: string };
type InsightLike = { kind: string; content: string };

type Props = {
  api: string;
  workstreamId: string;
  tasks: TaskLike[];
  events: EventLike[];
  insights?: InsightLike[];
  onStatus: (status: string) => void;
};

/**
 * The gate banner: when a workstream is waiting on the human, say so at the
 * top of the page — what is being decided, what the evidence is, and what
 * each button will do. Rendered only while status is waiting_for_human.
 */
export function ApprovalBanner({ api, workstreamId, tasks, events, insights = [], onStatus }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eventText = (event: EventLike) => event.message ?? event.content ?? "";
  let completionIndex = -1;
  let gatedIndex = -1;
  events.forEach((event, index) => {
    if (eventText(event).includes("[PROPOSE_COMPLETE]")) completionIndex = index;
    if (event.type === "task.gated") gatedIndex = index;
  });
  const synthesis = [...insights].reverse().find((insight) => insight.kind === "synthesis");
  const onlyCollaboration =
    tasks.length > 0 && tasks.every((task) => (task.title ?? "").includes("[Collaboration:"));

  let headline = "The team is paused, waiting for your decision.";
  let detail: string | undefined;
  if (completionIndex >= 0 && completionIndex > gatedIndex) {
    headline = "The team proposes this workstream is complete.";
    detail =
      eventText(events[completionIndex]).split("[PROPOSE_COMPLETE]").at(-1)?.trim().slice(0, 300) ||
      undefined;
  } else if (onlyCollaboration && synthesis) {
    headline = "The collaboration round is done — the synthesis is ready for your approval.";
    detail = parseStructuredContent(synthesis.content).summary.slice(0, 300);
  } else if (gatedIndex >= 0) {
    headline = "Execution is paused on a task that needs your decision.";
    detail = eventText(events[gatedIndex]).split("→")[0]?.trim() || undefined;
  }

  async function decide(decision: "resume" | "complete" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch(`${api}/api/workstreams/${workstreamId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: `approval-${decision}-${Date.now()}`, decision }),
      });
      const result = (await response.json()) as { status?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Approval failed");
      if (result.status) onStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="cc-approval-banner" role="alert">
      <div className="cc-approval-banner-text">
        <Group gap="xs">
          <ThemeIcon size="sm" radius="xl" color="yellow" variant="light">
            <IconHandStop size={13} />
          </ThemeIcon>
          <Text fw={800} size="sm">
            Waiting for your approval
          </Text>
        </Group>
        <Text size="sm" mt={6}>
          {headline}
        </Text>
        {detail && (
          <Text size="sm" c="dimmed" mt={2}>
            {detail}
          </Text>
        )}
        {error && (
          <Text size="sm" c="red" mt={4}>
            {error}
          </Text>
        )}
      </div>
      <Group gap="lg" align="flex-start">
        <Stack gap={2} align="center">
          <Button color="green" loading={busy === "resume"} disabled={busy !== null && busy !== "resume"} onClick={() => void decide("resume")}>
            Approve &amp; continue
          </Button>
          <Text size="xs" c="dimmed">
            Team keeps executing
          </Text>
        </Stack>
        <Stack gap={2} align="center">
          <Button variant="default" loading={busy === "complete"} disabled={busy !== null && busy !== "complete"} onClick={() => void decide("complete")}>
            Approve &amp; complete
          </Button>
          <Text size="xs" c="dimmed">
            Accept &amp; close the workstream
          </Text>
        </Stack>
        <Stack gap={2} align="center">
          <Button variant="subtle" color="red" loading={busy === "reject"} disabled={busy !== null && busy !== "reject"} onClick={() => void decide("reject")}>
            Reject
          </Button>
          <Text size="xs" c="dimmed">
            Send it back for more work
          </Text>
        </Stack>
      </Group>
    </div>
  );
}
