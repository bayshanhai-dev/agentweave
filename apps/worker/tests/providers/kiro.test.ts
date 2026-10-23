import { describe, expect, it } from "vitest";
import { KiroAdapter, type KiroProcessRunner } from "../../src/providers/kiro.js";
import { buildKiroCommand } from "../../src/providers/kiro-command.js";
import type { ProviderRunEvent } from "../../src/providers/types.js";

async function* chunks(values: string[]) { for (const value of values) yield value; }
async function collect<T>(stream: AsyncGenerator<ProviderRunEvent, T>) { const events = []; let step = await stream.next(); while (!step.done) { events.push(step.value); step = await stream.next(); } return { events, result: step.value }; }

describe("Kiro provider", () => {
  it("isolates command construction and carries workspace, model, and resume state", () => {
    const session = { provider: "kiro", providerSessionId: "session-1", status: "active", createdAt: "now", updatedAt: "now", model: "session-model" };
    expect(buildKiroCommand({ command: "kiro-custom" }, { input: "work", model: "turn-model", workspacePath: "/repo" }, session, true)).toEqual({
      command: "kiro-custom",
      args: ["chat", "--no-interactive", "--agent-engine", "v2", "--output-format", "stream-json", "--trust-all-tools", "--resume-id", "session-1", "--model", "turn-model"],
      stdin: "work",
      options: { cwd: "/repo" },
    });
  });

  it("persists the verified stream session id and emits only explicit usage", async () => {
    const runner: KiroProcessRunner = () => ({ code: Promise.resolve(0), stdout: chunks([
      '{"type":"session.started","data":{"sessionId":"kiro-real"}}\n',
      '{"type":"content","data":{"text":"done"}}\n{"type":"usage","data":{"inputTokens":2,"outputTokens":1}}\n',
      '{"type":"completion"}\n',
    ]), stderr: chunks([]), kill: () => undefined });
    const run = await collect(new KiroAdapter(runner).run({ input: "work", correlationId: "corr" }));
    expect(run.result.session.providerSessionId).toBe("kiro-real");
    expect(run.result.usage).toEqual({ source: "provider", inputTokens: 2, outputTokens: 1 });
    expect(run.events.map((event) => event.type)).toEqual(["turn.started", "session.started", "turn.delta", "usage.updated", "turn.completed"]);
  });

  it("does not synthesize usage when Kiro omits it", async () => {
    const runner: KiroProcessRunner = () => ({ code: Promise.resolve(0), stdout: chunks(['{"type":"content","text":"ok"}\n{"type":"completion"}\n']), stderr: chunks([]), kill: () => undefined });
    const run = await collect(new KiroAdapter(runner).run({ input: "work" }));
    expect(run.result.usage).toBeUndefined();
    expect(run.events.some((event) => event.type === "usage.updated")).toBe(false);
  });

  it("terminates an active child on cancellation", async () => {
    let finishStdout!: () => void; let finishCode!: (code: number) => void; const signals: Array<NodeJS.Signals | undefined> = [];
    const stdoutClosed = new Promise<void>((resolve) => { finishStdout = resolve; });
    const stdout = (async function* () { await stdoutClosed; })();
    const code = new Promise<number>((resolve) => { finishCode = resolve; });
    const runner: KiroProcessRunner = () => ({ code, stdout, stderr: chunks([]), kill: (signal) => { signals.push(signal); finishStdout(); finishCode(143); } });
    const adapter = new KiroAdapter(runner, { killGraceMs: 1 });
    const stream = adapter.run({ input: "work" });
    const started = await stream.next();
    expect(started.value.type).toBe("turn.started");
    const turnId = started.value.type === "turn.started" ? started.value.turnId : "";
    await collect(adapter.cancel(await adapter.createSession(), turnId));
    await expect(collect(stream)).rejects.toMatchObject({ code: "KIRO_CANCELLED", category: "cancelled" });
    expect(signals).toContain("SIGTERM");
  });

  it("classifies abnormal stderr and drains it without exposing secrets", async () => {
    const runner: KiroProcessRunner = () => ({ code: Promise.resolve(1), stdout: chunks([]), stderr: chunks(["authentication failed token=secret"]), kill: () => undefined });
    await expect(collect(new KiroAdapter(runner).run({ input: "work" }))).rejects.toMatchObject({ code: "KIRO_AUTHENTICATION", category: "authentication", retry: "user-action-required" });
  });
});
