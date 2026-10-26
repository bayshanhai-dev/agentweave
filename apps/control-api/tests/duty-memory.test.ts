import { describe, expect, it, vi } from "vitest";
import {
  applyDutyStateWriteback,
  dutyPromptForFire,
  dutyStateWritebackContract,
  type DutyContext,
} from "../src/duty-memory.js";
import type { Trigger } from "../src/trigger-scheduler.js";

const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: "trigger-1",
  name: "Daily review",
  enabled: true,
  kind: "schedule",
  cronExpr: "0 9 * * *",
  timezone: "UTC",
  targetMode: "workstream",
  targetWorkstreamId: "ws-1",
  dutyTitle: "Review",
  dutyPrompt: "Review production",
  priority: 0,
  batchWindowSec: 0,
  overlapPolicy: "skip",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("duty scheduler memory injection", () => {
  it("injects pretty-printed existing state and the write-back contract", async () => {
    const getState = vi.fn(async () => ({
      state: { issue: "api", conclusion: "fixed" },
    }));
    const prompt = await dutyPromptForFire(
      trigger({ stateKey: "release-watch" }),
      "ws-1",
      "Review production",
      getState,
    );
    expect(prompt).toContain(
      "## Duty memory (key: release-watch) — your state from previous cycles",
    );
    expect(prompt).toContain('  "conclusion": "fixed"');
    expect(prompt).toContain(
      "Continue from this state. Do not redo work it records as done.",
    );
    expect(prompt).toContain(dutyStateWritebackContract);
    expect(getState).toHaveBeenCalledWith("ws-1", "release-watch");
  });

  it("injects the first-cycle section when state is absent or empty", async () => {
    for (const stored of [undefined, { state: {} }]) {
      const prompt = await dutyPromptForFire(
        trigger(),
        "ws-1",
        "Review production",
        async () => stored,
      );
      expect(prompt).toContain("## Duty memory (key: Daily review)");
      expect(prompt).toContain(
        "No stored state yet — this is your first recorded cycle.",
      );
      expect(prompt).toContain(dutyStateWritebackContract);
    }
  });

  it("leaves create-mode prompts unchanged and does not load state", async () => {
    const getState = vi.fn(async () => ({ state: { ignored: true } }));
    await expect(
      dutyPromptForFire(
        trigger({ targetMode: "create", targetWorkstreamId: undefined }),
        "new-ws",
        "Create-mode prompt",
        getState,
      ),
    ).resolves.toBe("Create-mode prompt");
    expect(getState).not.toHaveBeenCalled();
  });
});

describe("duty completion write-back", () => {
  const context: DutyContext = {
    triggerId: "trigger-1",
    workstreamId: "ws-1",
    stateKey: "release-watch",
  };

  function dependencies(duty: DutyContext | null = context) {
    const events: Array<{ type: string; message: string }> = [];
    const upsert = vi.fn(async () => undefined);
    return {
      events,
      upsert,
      input: {
        findDutyContextByTaskId: vi.fn(async () => duty ?? undefined),
        upsert,
        recordEvent: (
          type: "duty.state_updated" | "duty.state_rejected",
          message: string,
        ) => events.push({ type, message }),
      },
    };
  }

  it("upserts state and records an update only for a fired duty task", async () => {
    const deps = dependencies();
    await expect(
      applyDutyStateWriteback("task-1", { cursor: 3 }, deps.input),
    ).resolves.toEqual({ status: "updated", key: "release-watch" });
    expect(deps.upsert).toHaveBeenCalledWith("ws-1", "release-watch", {
      cursor: 3,
    });
    expect(deps.events).toEqual([
      {
        type: "duty.state_updated",
        message: "Duty memory updated for key release-watch",
      },
    ]);
  });

  it("ignores dutyState submitted by a non-duty task", async () => {
    const deps = dependencies(null);
    await expect(
      applyDutyStateWriteback("ordinary-task", { cursor: 3 }, deps.input),
    ).resolves.toEqual({ status: "ignored" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.events).toEqual([]);
  });

  it("rejects oversize state and leaves the previous state intact", async () => {
    const deps = dependencies();
    const previous = { cursor: 2 };
    await expect(
      applyDutyStateWriteback(
        "task-1",
        { payload: "x".repeat(33 * 1024) },
        deps.input,
      ),
    ).resolves.toMatchObject({ status: "rejected", key: "release-watch" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(previous).toEqual({ cursor: 2 });
    expect(deps.events).toEqual([
      expect.objectContaining({
        type: "duty.state_rejected",
        message: expect.stringContaining("exceeds 32 KB"),
      }),
    ]);
  });

  it.each([null, [], "state"])(
    "rejects non-object state: %j",
    async (value) => {
      const deps = dependencies();
      await expect(
        applyDutyStateWriteback("task-1", value, deps.input),
      ).resolves.toMatchObject({ status: "rejected" });
      expect(deps.upsert).not.toHaveBeenCalled();
      expect(deps.events[0]).toMatchObject({ type: "duty.state_rejected" });
    },
  );

  it("keeps completion best-effort when persistence fails", async () => {
    const deps = dependencies();
    deps.upsert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      applyDutyStateWriteback("task-1", { cursor: 4 }, deps.input),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(deps.events[0]).toMatchObject({
      type: "duty.state_rejected",
      message: expect.stringContaining("previous state was kept"),
    });
  });
});
