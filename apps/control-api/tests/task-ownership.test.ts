import { describe, expect, it, vi } from "vitest";
import {
  createTasksWithOwnerFallback,
  type OwnedTask,
} from "../src/task-ownership.js";

const policy = { leadRole: "pm" };

function fixture() {
  const workstream = {
    id: "ws-1",
    agents: [
      { id: "pm-1", role: "pm" },
      { id: "backend-1", role: "backend" },
    ],
    tasks: [] as OwnedTask[],
  };
  const persistTask = vi.fn(async () => undefined);
  const emit = vi.fn();
  let nextId = 0;
  const dependencies = {
    persistTask,
    emit,
    now: () => new Date("2026-10-25T12:00:00.000Z"),
    createId: () => `id-${++nextId}`,
  };
  return { workstream, dependencies, persistTask, emit };
}

describe("task owner fallback", () => {
  it("assigns a missing owner role to the lead and emits a visible event", async () => {
    const { workstream, dependencies, emit } = fixture();

    const [task] = await createTasksWithOwnerFallback(
      workstream,
      [{ title: "Production build" }],
      policy,
      dependencies,
      "pm-1",
    );

    expect(task).toMatchObject({ status: "assigned", ownerAgentId: "pm-1" });
    expect(emit).toHaveBeenCalledWith(
      "orchestration.task_owner_defaulted",
      expect.stringContaining(
        'Task "Production build" defaulted to lead role pm (requested role: unspecified)',
      ),
      "pm",
    );
  });

  it("assigns an unmatched owner role to the lead and names the requested role", async () => {
    const { workstream, dependencies, emit, persistTask } = fixture();

    const [task] = await createTasksWithOwnerFallback(
      workstream,
      [{ title: "TypeScript checks", ownerRole: "release" }],
      policy,
      dependencies,
    );

    expect(task).toMatchObject({ status: "assigned", ownerAgentId: "pm-1" });
    expect(persistTask).toHaveBeenCalledWith(task);
    expect(emit).toHaveBeenCalledWith(
      "orchestration.task_owner_defaulted",
      expect.stringContaining("requested role: release"),
      undefined,
    );
  });
});
