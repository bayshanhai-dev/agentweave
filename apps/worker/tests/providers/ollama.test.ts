import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { createProviderFromEnv } from "../../src/providers/registry.js";
import type { ProviderRunEvent } from "../../src/providers/types.js";

type ScriptedChunk = {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{ id?: string; function: { name: string; arguments: unknown } }>;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
};

async function collect<T>(stream: AsyncGenerator<ProviderRunEvent, T>) {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, result: step.value };
}

function scriptedFetch(rounds: ScriptedChunk[][]): typeof fetch {
  let nextRound = 0;
  return (async () => {
    const chunks = rounds[nextRound++];
    if (!chunks) throw new Error("Unexpected Ollama request");
    return new Response(`${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }) as typeof fetch;
}

describe("Ollama provider adapter", () => {
  it("runs a tool loop, writes the requested file, and accumulates usage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentweave-ollama-"));
    try {
      const fetchFn = scriptedFetch([
        [
          { message: { role: "assistant", content: "Let me create that file." } },
          { message: { role: "assistant", tool_calls: [{ id: "write-1", function: { name: "write_file", arguments: { path: "notes/result.txt", content: "created by ollama" } } }] } },
          { done: true, prompt_eval_count: 50, eval_count: 10 },
        ],
        [
          { message: { role: "assistant", content: "Done" } },
          { message: { role: "assistant", content: " — file created." } },
          { done: true, prompt_eval_count: 80, eval_count: 6 },
        ],
      ]);
      const run = await collect(new OllamaAdapter({ model: "test-model", fetchFn }).run({
        input: "Create the file.",
        workspacePath: workspace,
        correlationId: "corr-tool-loop",
      }));

      expect(run.events.map((event) => event.type)).toEqual([
        "turn.started",
        "turn.delta",
        "tool.started",
        "tool.completed",
        "turn.delta",
        "turn.delta",
        "usage.updated",
        "turn.completed",
      ]);
      expect(run.events.find((event) => event.type === "tool.started")).toMatchObject({ toolName: "write_file", toolCallId: "write-1" });
      expect(run.result.text).toBe("Done — file created.");
      expect(run.result.usage).toEqual({ source: "provider", inputTokens: 130, outputTokens: 16, totalTokens: 146 });
      expect(await readFile(join(workspace, "notes/result.txt"), "utf8")).toBe("created by ollama");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a tool error when a file path escapes the workspace", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentweave-ollama-confined-"));
    const workspace = join(tempRoot, "workspace");
    await mkdir(workspace);
    await writeFile(join(tempRoot, "secret.txt"), "must not be exposed", "utf8");
    try {
      const fetchFn = scriptedFetch([
        [
          { message: { role: "assistant", tool_calls: [{ id: "read-1", function: { name: "read_file", arguments: { path: "../secret.txt" } } }] } },
          { done: true },
        ],
        [
          { message: { role: "assistant", content: "I could not read outside the workspace." } },
          { done: true },
        ],
      ]);
      const run = await collect(new OllamaAdapter({ model: "test-model", fetchFn }).run({ input: "Read the secret.", workspacePath: workspace }));
      const completed = run.events.find((event) => event.type === "tool.completed");

      expect(completed).toMatchObject({ type: "tool.completed", toolName: "read_file" });
      expect(completed && "output" in completed ? completed.output : "").toContain("escapes the workspace");
      expect(completed && "output" in completed ? completed.output : "").not.toContain("must not be exposed");
      expect(run.result.text).toBe("I could not read outside the workspace.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("registers Ollama and normalizes transport failures", async () => {
    expect(createProviderFromEnv({ AGENTWEAVE_PROVIDER: "ollama" } as NodeJS.ProcessEnv).name).toBe("ollama");

    const fetchFn = (async () => { throw new Error("connection refused"); }) as typeof fetch;
    const stream = new OllamaAdapter({ model: "test-model", fetchFn }).run({ input: "hello", correlationId: "corr-transport" });
    expect(await stream.next()).toMatchObject({ value: { type: "turn.started" }, done: false });
    expect(await stream.next()).toMatchObject({
      value: {
        type: "turn.failed",
        error: { code: "OLLAMA_TRANSPORT", category: "transport", retry: "retryable", provider: "ollama" },
      },
      done: false,
    });
    await expect(stream.next()).rejects.toThrow("connection refused");
  });
});
