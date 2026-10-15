import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProviderAdapter } from "../../src/providers/mock.js";
import type { AgentSessionRepository } from "../../src/providers/session-repository.js";
import { AgentTaskExecutor } from "../../src/runtime/execution.js";

const sessions = (): AgentSessionRepository => ({
  listUnfinished: vi.fn(async () => []),
  save: vi.fn(async () => {}),
  acquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => {}),
  claimTask: vi.fn(async () => true),
  finishTask: vi.fn(async () => {}),
});

const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (previousWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace execution", () => {
  it("creates a missing workspace before creating the provider session", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentweave-worker-"));
    temporaryRoots.push(root);
    process.env.WORKSPACE_ROOT = root;
    const workspacePath = join(root, "new", "workstream");
    const provider = new MockProviderAdapter();
    const createSession = vi.spyOn(provider, "createSession");
    createSession.mockImplementationOnce(async (input) => {
      await expect(access(workspacePath)).resolves.toBeUndefined();
      return new MockProviderAdapter().createSession(input);
    });
    const sink = vi.fn(async () => {});

    await new AgentTaskExecutor(provider, sessions(), "worker", sink).execute({
      taskId: "missing-workspace",
      agentId: "pm",
      prompt: "Complete this task.",
      workspacePath,
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ workspacePath }));
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ type: "task.completed" }));
  });
});
