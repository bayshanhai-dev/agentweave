import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_LANES, TaskBoard, type Task, type TaskLane } from "../src/TaskBoard";
import { TaskBoardSidecar } from "../src/TaskBoardSidecar";

function task(id: string, status: string): Task {
  return {
    id,
    title: `Task ${id}`,
    status,
    relatedTaskIds: [],
    acceptanceCriteria: [],
    dependencies: [],
    evidence: [],
  };
}

function renderBoard(tasks: Task[], lanes?: TaskLane[]): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <TaskBoard tasks={tasks} lanes={lanes} />
    </MantineProvider>,
  );
}

describe("TaskBoard lanes", () => {
  it("renders all five standard lanes in order, including empty lanes", () => {
    const markup = renderBoard([task("todo", "assigned"), task("done", "done")]);

    const lanePositions = DEFAULT_LANES.map((lane) => markup.indexOf(`>${lane.label}</`));
    expect(lanePositions.every((position) => position >= 0)).toBe(true);
    expect(lanePositions).toEqual([...lanePositions].sort((a, b) => a - b));
    expect(markup.match(/class="cc-kanban-lane"/g)).toHaveLength(5);
    expect(markup.match(/>No tasks</g)).toHaveLength(3);
    expect(markup).not.toContain("No tasks in");
    expect(markup).not.toContain(">Other</");
  });

  it("renders the extra lane only when a task has a non-standard status", () => {
    const standardMarkup = renderBoard([task("todo", "assigned")]);
    const overflowMarkup = renderBoard([task("todo", "assigned"), task("blocked", "blocked")]);

    expect(standardMarkup).not.toContain(">Other</");
    expect(standardMarkup.match(/class="cc-kanban-lane"/g)).toHaveLength(5);
    expect(overflowMarkup).toContain(">Other</");
    expect(overflowMarkup.match(/class="cc-kanban-lane"/g)).toHaveLength(6);
    expect(overflowMarkup.indexOf(">Other</")).toBeGreaterThan(overflowMarkup.indexOf(">Done</"));
  });

  it("shows counts for every standard lane in the sidecar summary", () => {
    const markup = renderToStaticMarkup(
      <MantineProvider>
        <TaskBoardSidecar tasks={[task("todo", "assigned"), task("done", "done")]} />
      </MantineProvider>,
    );

    expect(markup).toContain("Backlog · 0");
    expect(markup).toContain("To Do · 1");
    expect(markup).toContain("In Progress · 0");
    expect(markup).toContain("Review · 0");
    expect(markup).toContain("Done · 1");
    expect(markup).not.toContain("No tasks in");
  });

  it("renders every caller-provided custom lane", () => {
    const customLanes: TaskLane[] = [
      { status: "queued", label: "Queue", color: "gray" },
      { status: "active", label: "Active", color: "blue" },
    ];

    const markup = renderBoard([task("active", "active")], customLanes);

    expect(markup).toContain(">Queue</");
    expect(markup).toContain(">Active</");
    expect(markup.match(/class="cc-kanban-lane"/g)).toHaveLength(2);
  });
});
