import { ActionIcon, Badge, Group, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { DEFAULT_LANES, TaskBoard, type Task, type TaskLane } from "./TaskBoard";

const STORAGE_KEY = "agentweave:board-sidecar-open";
const PANEL_ID = "cc-board-sidecar-panel";

type AgentLike = { id: string; role: string };

/** Mantine lane colour names to dot colours for the edge tab. */
const LANE_DOT_COLORS: Record<string, string> = {
  gray: "#868e96",
  blue: "#4dabf7",
  yellow: "#ffd43b",
  violet: "#9775fa",
  green: "#69db7c",
  red: "#ff8787",
  orange: "#ffa94d",
  cyan: "#3bc9db",
  grape: "#da77f2",
  pink: "#faa2c1",
  teal: "#38d9a9",
  lime: "#a9e34b",
  indigo: "#748ffc",
};

/**
 * The task board as a right-edge sidecar: a slim vertical tab shows the
 * task total and the per-lane counts; clicking it slides a wide panel in
 * over the page (below the app header) so the live stream stays in place
 * behind a scrim instead of being scrolled away from.
 *
 * The open/closed choice persists in localStorage. The closed panel is
 * inert and aria-hidden; Escape, the scrim, the close button and the tab
 * itself all close it. The tab's visible label is CSS-rendered (see
 * styles.css) so the DOM never carries a second bare "Task board" text
 * next to the board's own header.
 */
export function TaskBoardSidecar({ tasks, lanes, agents }: { tasks: Task[]; lanes?: TaskLane[]; agents?: AgentLike[] }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "open";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
    } catch {
      // Storage unavailable (private mode): the panel still works per session.
    }
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open ]);

  const columns = lanes?.length ? lanes : DEFAULT_LANES;
  const laneCounts = columns.map((column) => ({
    column,
    count: tasks.filter((task) => task.status === column.status).length,
  }));
  const knownStatuses = new Set(columns.map((column) => column.status));
  const overflowCount = tasks.filter((task) => !knownStatuses.has(task.status)).length;
  const hasFailed = tasks.some((task) => task.status === "failed");
  const hasRunning = tasks.some((task) => task.status === "running");
  const tabStateClass = hasFailed ? " cc-board-edge-tab-failed" : hasRunning ? " cc-board-edge-tab-running" : "";

  return (
    <>
      <button
        type="button"
        className={`cc-board-edge-tab${tabStateClass}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? "Close task board" : "Open task board"}
      >
        <span className="cc-board-edge-tab-label" aria-hidden />
        <span className="cc-board-edge-tab-count" aria-hidden>{tasks.length}</span>
        <span className="cc-board-edge-tab-lanes" aria-hidden>
          {laneCounts.map(({ column, count }) => (
            <span key={column.status} className={`cc-board-edge-lane${count === 0 ? " cc-board-edge-lane-empty" : ""}`}>
              <span className="cc-board-edge-dot" style={{ background: LANE_DOT_COLORS[column.color] ?? LANE_DOT_COLORS.gray }} />
              {count}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="cc-board-edge-lane">
              <span className="cc-board-edge-dot" style={{ background: LANE_DOT_COLORS.gray }} />
              {overflowCount}
            </span>
          )}
        </span>
      </button>
      {open && <div className="cc-board-sidecar-scrim" onClick={() => setOpen(false)} aria-hidden />}
      <aside
        id={PANEL_ID}
        className={`cc-board-sidecar${open ? " cc-board-sidecar-open" : ""}`}
        role="complementary"
        aria-label="Task board"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="cc-board-sidecar-header">
          <Group gap="xs">
            {laneCounts
              .filter(({ count }) => count > 0)
              .map(({ column, count }) => (
                <Badge key={column.status} variant="light" color={column.color}>
                  {column.label} · {count}
                </Badge>
              ))}
            {overflowCount > 0 && (
              <Badge variant="light" color="gray">
                Other · {overflowCount}
              </Badge>
            )}
            {tasks.length === 0 && (
              <Text size="sm" c="dimmed">
                No tasks yet
              </Text>
            )}
          </Group>
          <ActionIcon variant="subtle" color="gray" onClick={() => setOpen(false)} aria-label="Close task board">
            <IconX size={18} />
          </ActionIcon>
        </div>
        <div className="cc-board-sidecar-body">
          <TaskBoard tasks={tasks} lanes={lanes} agents={agents} embedded />
        </div>
      </aside>
    </>
  );
}
