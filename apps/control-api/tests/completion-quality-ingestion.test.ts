import { describe, expect, it, vi } from "vitest";
import { applyArtifactQualityGate } from "../src/artifact-quality.js";

function fixture() {
  const workstream = { status: "active" };
  const task = {
    id: "task-script",
    title: "Write the episode script",
    status: "running",
    ownerAgentId: "writer-1",
    qualityAttempts: 0,
  };
  const events: Array<{ type: string; message: string; taskId?: string }> = [];
  const dispatches: Array<{ recipientId: string; taskId: string; content: string }> = [];
  const dependencies = {
    persistTask: vi.fn(async () => undefined),
    persistWorkstream: vi.fn(async () => undefined),
    setAgentIdle: vi.fn(async () => undefined),
    emit: vi.fn((event: (typeof events)[number]) => events.push(event)),
    dispatchRework: vi.fn(async (input: (typeof dispatches)[number]) => { dispatches.push(input); }),
  };
  return { workstream, task, events, dispatches, dependencies };
}

describe("artifact quality completion ingestion", () => {
  it("keeps a junk completion assigned, emits a rejection, and dispatches exact rework", async () => {
    const state = fixture();
    const outcome = await applyArtifactQualityGate(
      state.workstream,
      state.task,
      [{ path: "script.md", content: "This is a well-written and engaging podcast script." }],
      "writer-1",
      state.dependencies,
    );

    expect(outcome).toBe("rework");
    expect(state.task).toMatchObject({ status: "assigned", qualityAttempts: 1 });
    expect(state.events[0]).toMatchObject({ type: "task.quality_rejected", taskId: "task-script" });
    expect(state.dispatches[0]).toMatchObject({ recipientId: "writer-1", taskId: "task-script" });
    expect(state.dispatches[0]?.content).toContain("script.md: artifact too small");
    expect(state.dispatches[0]?.content).toContain("at least 200 characters");
  });

  it("parks the workstream with reasons after the second rejection", async () => {
    const state = fixture();
    state.task.qualityAttempts = 1;
    const outcome = await applyArtifactQualityGate(
      state.workstream,
      state.task,
      [{ path: "episode.md", content: `${"Details. ".repeat(40)}[TODO add the actual episode]` }],
      "writer-1",
      state.dependencies,
    );

    expect(outcome).toBe("parked");
    expect(state.task).toMatchObject({ status: "assigned", qualityAttempts: 2 });
    expect(state.workstream.status).toBe("waiting_for_human");
    expect(state.dispatches).toEqual([]);
    expect(state.events.at(-1)).toMatchObject({
      type: "workstream.waiting_for_human",
      message: expect.stringContaining("placeholder residue"),
    });
  });

  it("allows a good written artifact to continue to the existing done path", async () => {
    const state = fixture();
    const content = "A concrete deliverable paragraph with useful detail, examples, and decisions. ".repeat(5);
    await expect(applyArtifactQualityGate(
      state.workstream,
      state.task,
      [{ path: "script.md", content }],
      "writer-1",
      state.dependencies,
    )).resolves.toBe("accepted");
    expect(state.task).toMatchObject({ status: "running", qualityAttempts: 0 });
    expect(state.events).toEqual([]);
    expect(state.dispatches).toEqual([]);
  });

  it("does not let a reviewer pass override a rejected implementation artifact", async () => {
    const state = fixture();
    const outcome = await applyArtifactQualityGate(
      state.workstream,
      state.task,
      [{ path: "script.md", content: "[Insert finished podcast script here]" }],
      "writer-1",
      state.dependencies,
    );
    expect(outcome).toBe("rework");
    expect(state.task.status).not.toBe("done");
    expect(state.dispatches[0]?.recipientId).toBe("writer-1");
  });
});
