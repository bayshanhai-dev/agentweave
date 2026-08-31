import { Badge, Card, Group, Progress, ScrollArea, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconAlertTriangle, IconBrain, IconCheck, IconClock, IconPlayerPlay, IconRefresh, IconTool } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { providerModelLabel } from "./providerDisplay";

export type RunEvent = {
  id?: string;
  type?: string;
  message?: string;
  content?: string;
  role?: string;
  provider?: string;
  model?: string;
  usage?: { source?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  occurredAt?: string;
};

type Props = {
  status: string;
  provider: { tool: string; model: string };
  events: RunEvent[];
};

const roleLabels: Record<string, string> = { pm: "PM", pe: "PE", coder: "Coder", qa: "QA" };

function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function RunConsole({ status, provider, events }: Props) {
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const run = useMemo(() => {
    const lifecycle = events.filter((event) =>
      ["run.started", "run.heartbeat", "turn.started", "turn.delta", "tool.started", "tool.completed", "turn.completed", "turn.failed", "turn.cancelled", "task.completed", "task.failed"].includes(event.type ?? ""),
    ).slice().reverse();
    const latest = lifecycle[0];
    const latestRun = lifecycle.find((event) => event.type === "run.heartbeat" || event.type === "run.started");
    const latestTurn = lifecycle.find((event) => event.type === "turn.started" || event.type === "turn.delta");
    const role = latest?.role ?? latestRun?.role ?? latestTurn?.role;
    const output = lifecycle
      .filter((event) => event.type === "turn.delta")
      .slice(0, 80)
      .reverse()
      .map((event) => event.message ?? event.content ?? "")
      .join("");
    const latestTime = latestRun?.occurredAt ? Date.parse(latestRun.occurredAt) : NaN;
    const elapsedMatch = latestRun?.message?.match(/(\d+)s/);
    const elapsed = elapsedMatch ? Number(elapsedMatch[1]) * 1000 : Number.isNaN(latestTime) ? 0 : Date.now() - latestTime;
    const terminal = ["completed", "waiting_for_human", "emergency_stopped", "archived"].includes(status) || ["task.completed", "task.failed", "turn.failed", "turn.cancelled"].includes(latest?.type ?? "");
    const failed = status === "failed" || ["task.failed", "turn.failed"].includes(latest?.type ?? "");
    const phase = latest?.type === "tool.started" ? "Using tools" : latest?.type === "tool.completed" ? "Tool completed" : latest?.type === "turn.delta" || latest?.type === "turn.started" ? "Thinking / responding" : latest?.type === "task.completed" ? "Task completed" : latest?.type === "task.failed" || latest?.type === "turn.failed" ? "Execution failed" : latest?.type === "run.heartbeat" || latest?.type === "run.started" ? "Starting provider turn" : "Waiting for run";
    const usage = lifecycle.find((event) => event.usage)?.usage;
    return { latest, role, output, elapsed, phase, terminal, failed, latestTime, usage };
  }, [events, status]);

  const hasRun = events.some((event) => event.type === "run.started" || event.type === "turn.started");
  const isRunning = hasRun && !run.terminal && !run.failed && ["starting", "active", "resuming"].includes(status);
  const lastOutput = run.latestTime && !Number.isNaN(run.latestTime) ? `${elapsedLabel(Math.max(0, Date.now() - run.latestTime))} ago` : "No output yet";

  return (
    <Card withBorder radius="lg" padding="lg" className="run-console" data-testid="run-console">
      <Group justify="space-between" align="flex-start">
        <Group gap="sm">
          <ThemeIcon size="lg" radius="md" color={run.failed ? "red" : isRunning ? "teal" : "gray"} variant="light">
            {run.failed ? <IconAlertTriangle size={19} /> : isRunning ? <IconPlayerPlay size={19} /> : run.terminal ? <IconCheck size={19} /> : <IconBrain size={19} />}
          </ThemeIcon>
          <div>
            <Text size="xs" tt="uppercase" c="dimmed" fw={800}>Live execution</Text>
            <Title order={3} mt={3}>{run.failed ? "Run needs attention" : run.terminal ? "Run settled" : hasRun ? "Codex is working" : "Waiting for Codex"}</Title>
          </div>
        </Group>
        <Badge color={run.failed ? "red" : isRunning ? "teal" : run.terminal ? "green" : "gray"} variant="light">
          {run.failed ? "failed" : isRunning ? "live" : run.terminal ? "settled" : status.replaceAll("_", " ")}
        </Badge>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 5 }} mt="lg">
        <div><Text size="xs" c="dimmed">ACTIVE AGENT</Text><Text fw={800} mt={3}>{roleLabels[run.role ?? ""] ?? run.role ?? "—"}</Text></div>
        <div><Text size="xs" c="dimmed">PHASE</Text><Text fw={800} mt={3}>{run.phase}</Text></div>
        <div><Text size="xs" c="dimmed">PROVIDER</Text><Text fw={800} mt={3}>{provider.tool} · {providerModelLabel(provider.model)}</Text></div>
        <div><Text size="xs" c="dimmed">LAST SIGNAL</Text><Text fw={800} mt={3}>{lastOutput}</Text></div>
        <div><Text size="xs" c="dimmed">USAGE</Text><Text fw={800} mt={3}>{run.usage?.totalTokens !== undefined ? `${run.usage.totalTokens.toLocaleString()} tokens` : "Unknown"}</Text><Text size="xs" c="dimmed">{run.usage?.costUsd !== undefined ? `$${run.usage.costUsd.toFixed(4)}` : "Provider did not report cost"}</Text></div>
      </SimpleGrid>

      {isRunning && <Progress value={100} animated mt="lg" size="sm" color="teal" />}

      <Group gap="xs" mt="lg">
        <IconClock size={14} />
        <Text size="xs" c="dimmed">Elapsed {elapsedLabel(run.elapsed)} · {isRunning ? "streaming from Codex" : "provider session idle"}</Text>
        {run.latest?.type?.startsWith("tool.") && <><IconTool size={14} /><Text size="xs" c="dimmed">Tool activity visible below</Text></>}
        {!isRunning && hasRun && !run.terminal && <><IconRefresh size={14} /><Text size="xs" c="orange">No terminal signal yet</Text></>}
      </Group>

      <Stack gap="xs" mt="lg">
        <Text size="xs" tt="uppercase" c="dimmed" fw={800}>Codex output</Text>
        <ScrollArea h={150} type="auto" offsetScrollbars>
          <Text className="run-console-output" size="sm" c={run.failed ? "red" : undefined} style={{ whiteSpace: "pre-wrap" }}>
            {run.output || run.latest?.message || (hasRun ? "Codex connected. Waiting for the next streamed event…" : "Start the Workstream to connect the PM to Codex.")}
          </Text>
        </ScrollArea>
      </Stack>
    </Card>
  );
}
