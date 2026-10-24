import { describe, expect, it, vi } from "vitest";
import { dependencyInputsSection, loadWrittenArtifacts } from "../src/artifact-handoff.js";
import { reconcileDispatchableTasks } from "../src/wave-gate-reconciliation.js";

const policy = {
  templateId: "podcast",
  leadRole: "showrunner",
  planningRole: "producer",
  executionRoles: ["writer"],
  reviewRole: "editor",
};

function fixture(dependencies: string[]) {
  const upstream = {
    id: "research",
    title: "Research the topic",
    status: "done",
    ownerAgentId: "producer-1",
    acceptanceCriteria: ["research.md contains cited facts"],
    dependencies: [],
  };
  const downstream = {
    id: "script",
    title: "Write the episode",
    status: "assigned",
    ownerAgentId: "writer-1",
    acceptanceCriteria: ["episode.md contains at least 1,200 words and opening, interview, and closing sections"],
    dependencies,
  };
  const workstream = {
    id: "ws-podcast",
    status: "active",
    agents: [
      { id: "showrunner-1", role: "showrunner" },
      { id: "producer-1", role: "producer" },
      { id: "writer-1", role: "writer" },
    ],
    tasks: [upstream, downstream],
    messages: [],
  };
  const dispatchTask = vi.fn(async () => ({ deliveryStatus: "delivered" }));
  return { upstream, downstream, workstream, dispatchTask };
}

describe("dependency artifact handoff", () => {
  it("injects a done dependency's file path and content into dispatch", async () => {
    const state = fixture(["research"]);
    const events = [{
      type: "tool.completed",
      taskId: "research",
      toolName: "write_file",
      output: JSON.stringify({
        path: "research.md",
        content: "Verified research finding with a source and enough context for the script writer.",
      }),
    }];
    const inputsFromEarlierTasks = (task: typeof state.downstream) =>
      dependencyInputsSection(task, state.workstream.tasks, (taskId) =>
        loadWrittenArtifacts("/workspace", events, taskId, undefined, true)
      );

    await reconcileDispatchableTasks(state.workstream, policy, {
      hasExecutionClaim: vi.fn(async () => false),
      dispatchTask: state.dispatchTask,
      emit: vi.fn(),
      inputsFromEarlierTasks,
    });

    const content = state.dispatchTask.mock.calls[0]?.[0].content;
    expect(content).toContain("Inputs from earlier tasks:");
    expect(content).toContain("File: research.md");
    expect(content).toContain("Verified research finding");
  });

  it("does not inject an inputs section when a task declares no dependencies", async () => {
    const state = fixture([]);
    await reconcileDispatchableTasks(state.workstream, policy, {
      hasExecutionClaim: vi.fn(async () => false),
      dispatchTask: state.dispatchTask,
      emit: vi.fn(),
      inputsFromEarlierTasks: async (task) => dependencyInputsSection(task, state.workstream.tasks, async () => []),
    });
    expect(state.dispatchTask.mock.calls[0]?.[0].content).not.toContain("Inputs from earlier tasks:");
  });
});
