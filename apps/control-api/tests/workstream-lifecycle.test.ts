import { describe, expect, it, vi } from "vitest";
import {
  WorkstreamCommandError,
  WorkstreamLifecycleCommandHandler,
} from "../src/commands/workstream-lifecycle.js";

function repository(existing?: unknown) {
  return {
    findResponse: vi.fn(async () => existing),
    commit: vi.fn(async () => undefined),
  };
}

function workstream(status = "active") {
  return {
    id: "ws-1",
    status,
    agents: [
      { id: "pm-1", status: "running" as const },
      { id: "qa-1", status: "idle" as const },
    ],
  };
}

describe("WorkstreamLifecycleCommandHandler", () => {
  it("persists a pause command and all agent states through one repository boundary", async () => {
    const store = repository();
    const handler = new WorkstreamLifecycleCommandHandler(store);
    const state = workstream();
    const emit = vi.fn();
    const response = await handler.execute(
      state,
      "pause",
      { commandId: "command-1" },
      emit,
    );
    expect(state.status).toBe("paused");
    expect(state.agents.map((agent) => agent.status)).toEqual([
      "paused",
      "paused",
    ]);
    expect(store.commit).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      commandId: "command-1",
      status: "paused",
      accepted: true,
    });
  });

  it("returns an idempotent command response without mutating state", async () => {
    const existing = { commandId: "command-1", accepted: true };
    const store = repository(existing);
    const handler = new WorkstreamLifecycleCommandHandler(store);
    const state = workstream();
    expect(
      await handler.execute(
        state,
        "pause",
        { commandId: "command-1" },
        vi.fn(),
      ),
    ).toBe(existing);
    expect(state.status).toBe("active");
    expect(store.commit).not.toHaveBeenCalled();
  });

  it("rejects an invalid approval before persistence", async () => {
    const handler = new WorkstreamLifecycleCommandHandler(repository());
    await expect(
      handler.approve(workstream("draft"), { decision: "complete" }, vi.fn()),
    ).rejects.toBeInstanceOf(WorkstreamCommandError);
  });
});
