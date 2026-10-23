import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildKiroCommand } from "../../../../src/providers/kiro-command.js";
import { KiroAdapter } from "../../../../src/providers/kiro.js";
import type { ProviderRunEvent } from "../../../../src/providers/types.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-kiro-cli.sh");
const temporaryPaths: string[] = [];

async function collect<T>(stream: AsyncGenerator<ProviderRunEvent, T>) {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

async function temporaryDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for fixture output at ${path}`);
}

async function waitForFileContent(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if (await readFile(path, "utf8") === expected) return;
    } catch { /* The fixture may not have created the marker yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await readFile(path, "utf8")).toBe(expected);
}

beforeAll(async () => chmod(fixture, 0o755));
afterAll(async () => Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true }))));

describe("Kiro evidence-derived compatibility", () => {
  it("constructs the documented non-interactive streaming command", () => {
    const session = { provider: "kiro", providerSessionId: "session-1", status: "active" as const, createdAt: "now", updatedAt: "now", model: "session-model" };
    expect(buildKiroCommand(
      { command: fixture },
      { input: "work", model: "turn-model", workspacePath: "/repo" },
      session,
      true,
    )).toEqual({
      command: fixture,
      args: ["chat", "--no-interactive", "--agent-engine", "v2", "--output-format", "stream-json", "--trust-all-tools", "--resume-id", "session-1", "--model", "turn-model"],
      stdin: "work",
      options: { cwd: "/repo" },
    });
  });

  it("delivers the prompt on stdin and honors cwd, model, and resume arguments", async () => {
    const workspace = await temporaryDirectory("agentweave-kiro-cwd-");
    const capturePath = join(workspace, "invocation.txt");
    const adapter = new KiroAdapter(undefined, { command: fixture });
    const session = await adapter.createSession();
    session.providerSessionId = "resume-fixture";

    await expect(collect(adapter.run({
      input: `capture:${capturePath}:ship it`, workspacePath: workspace, model: "fixture-model", session,
    }))).rejects.toMatchObject({ code: "KIRO_EXIT", category: "provider" });

    expect(await readFile(capturePath, "utf8")).toBe([
      "stdin=ship it", `cwd=${workspace}`, "model=fixture-model", "resume=resume-fixture", "",
    ].join("\n"));
  });

  it("rejects an invalid working directory without invoking a shell", async () => {
    const missing = join(await temporaryDirectory("agentweave-kiro-missing-"), "does-not-exist");
    await expect(collect(new KiroAdapter(undefined, { command: fixture }).run({ input: "nonzero-exit", workspacePath: missing })))
      .rejects.toMatchObject({ code: "KIRO_TRANSPORT", category: "transport" });
  });

  it.each([
    ["authentication-error", { code: "KIRO_AUTHENTICATION", category: "authentication", retry: "user-action-required" }],
    ["nonzero-exit", { code: "KIRO_EXIT", category: "provider", retry: "retryable" }],
  ] as const)("classifies %s from a hermetic subprocess", async (mode, expected) => {
    await expect(collect(new KiroAdapter(undefined, { command: fixture }).run({ input: mode }))).rejects.toMatchObject(expected);
  });

  it("cancels and reaps the subprocess, then removes active-turn state", async () => {
    const directory = await temporaryDirectory("agentweave-kiro-cancel-");
    const markerPath = join(directory, "signals.log");
    // The grace must exceed the fixture's trap latency: bash only runs a TERM
    // trap between its sleep slices, so 50ms made this a scheduler race (it
    // failed intermittently under CI load). 1s still proves SIGTERM is sent
    // and honored before any SIGKILL escalation.
    const adapter = new KiroAdapter(undefined, { command: fixture, killGraceMs: 1_000 });
    const stream = adapter.run({ input: `cancel:${markerPath}` });
    const started = await stream.next();
    expect(started.value.type).toBe("turn.started");
    const turnId = started.value.type === "turn.started" ? started.value.turnId : "";
    await waitForFile(markerPath);
    expect(adapter.activeTurnCount).toBe(1);

    await collect(adapter.cancel(await adapter.createSession(), turnId));
    await expect(collect(stream)).rejects.toMatchObject({ code: "KIRO_CANCELLED", category: "cancelled" });
    await waitForFileContent(markerPath, "READY\nSIGTERM\n");
    expect(adapter.activeTurnCount).toBe(0);
  });
});
