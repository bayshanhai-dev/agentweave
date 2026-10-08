import { Group, Select, Text } from "@mantine/core";
import type { ReactNode } from "react";

type WorkstreamOption = { id: string; goal: string; status: string };
type TaskLike = { status: string };

type Props = {
  goal: string;
  tasks: TaskLike[];
  workstreams: WorkstreamOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  controls?: ReactNode;
};

/** Top banner: workstream goal, task progress, workstream switcher, controls. */
export function GoalBar({ goal, tasks, workstreams, selectedId, onSelect, controls }: Props) {
  const done = tasks.filter((task) => task.status === "done").length;
  const total = tasks.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className="cc-goalbar">
      <div className="cc-goalbar-inner">
        <Text className="cc-kicker">◎ Workstream goal</Text>
        <Text className="cc-goal-text" title={goal}>
          {goal}
        </Text>
        <div className="cc-goal-progress">
          <div className="cc-goal-progress-labels">
            <span>progress</span>
            <b>
              {done}/{total} · {pct}%
            </b>
          </div>
          <div className="cc-goal-progress-track">
            <div className="cc-goal-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <Select
          aria-label="Switch workstream"
          value={selectedId}
          onChange={(value) => value && onSelect(value)}
          data={workstreams.map((item) => ({ value: item.id, label: item.goal }))}
          allowDeselect={false}
          size="xs"
          className="cc-workstream-select"
          styles={{ input: { maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" } }}
        />
        {controls ? <Group gap="xs">{controls}</Group> : null}
      </div>
    </div>
  );
}
