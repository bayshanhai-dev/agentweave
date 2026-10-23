import { Group, Select, Text } from "@mantine/core";
import type { ReactNode } from "react";

type WorkstreamOption = { id: string; goal: string; status: string; createdAt?: string };
type TaskLike = { status: string; title?: string };

type Props = {
  goal: string;
  tasks: TaskLike[];
  workstreams: WorkstreamOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  controls?: ReactNode;
};

function optionMeta(item: WorkstreamOption): string {
  const when = item.createdAt
    ? new Date(item.createdAt).toLocaleString([], {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  // The leading bullet keeps this from ever being a bare status word —
  // the page already has a status badge, and duplicate bare "completed"
  // texts are ambiguous for users and assistive tech alike.
  return `• ${[item.status.replaceAll("_", " "), when].filter(Boolean).join(" · ")}`;
}

/** Top banner: workstream goal, task progress, workstream switcher, controls. */
export function GoalBar({ goal, tasks, workstreams, selectedId, onSelect, controls }: Props) {
  // Progress must not claim the job is done when only the discussion phase
  // is: collaboration tasks and implementation tasks are reported separately,
  // and the headline percentage tracks execution once it exists.
  const collaboration = tasks.filter((task) => (task.title ?? "").includes("[Collaboration:"));
  const implementation = tasks.filter((task) => !(task.title ?? "").includes("[Collaboration:"));
  const collabDone = collaboration.filter((task) => task.status === "done").length;
  const implDone = implementation.filter((task) => task.status === "done").length;

  let phaseLabel = "progress";
  let headline = "0/0 · 0%";
  let pct = 0;
  let subline: string | undefined;
  if (implementation.length > 0) {
    phaseLabel = "execution progress";
    pct = Math.round((implDone / implementation.length) * 100);
    headline = `${implDone}/${implementation.length} · ${pct}%`;
    subline =
      collaboration.length > 0
        ? `Discussion ${collabDone}/${collaboration.length} done`
        : undefined;
  } else if (collaboration.length > 0) {
    phaseLabel = "discussion progress";
    pct = Math.round((collabDone / collaboration.length) * 100);
    headline = `${collabDone}/${collaboration.length}`;
    subline = "Execution has not started — it begins after the synthesis is approved.";
  } else if (tasks.length > 0) {
    const done = tasks.filter((task) => task.status === "done").length;
    pct = Math.round((done / tasks.length) * 100);
    headline = `${done}/${tasks.length} · ${pct}%`;
  }

  return (
    <div className="cc-goalbar">
      <div className="cc-goalbar-inner">
        <Text className="cc-kicker">◎ Workstream goal</Text>
        <Text className="cc-goal-text" title={goal}>
          {goal}
        </Text>
        <div className="cc-goal-progress">
          <div className="cc-goal-progress-labels">
            <span>{phaseLabel}</span>
            <b>{headline}</b>
          </div>
          <div className="cc-goal-progress-track">
            <div className="cc-goal-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          {subline && (
            <Text size="xs" c="dimmed" className="cc-goal-progress-sub">
              {subline}
            </Text>
          )}
        </div>
        <Select
          aria-label="Switch workstream"
          value={selectedId}
          onChange={(value) => value && onSelect(value)}
          data={workstreams.map((item) => ({
            value: item.id,
            label: item.goal,
            status: item.status,
            createdAt: item.createdAt,
          }))}
          renderOption={({ option }) => {
            const item = option as typeof option & WorkstreamOption;
            return (
              <Group justify="space-between" gap="md" wrap="nowrap" style={{ width: "100%" }}>
                <Text size="sm" lineClamp={1}>
                  {item.label}
                </Text>
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {optionMeta(item)}
                </Text>
              </Group>
            );
          }}
          allowDeselect={false}
          size="xs"
          className="cc-workstream-select"
          styles={{ input: { maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" } }}
        />
        {controls ? <Group gap="xs">{controls}</Group> : null}
      </div>
    </div>
  );
}
