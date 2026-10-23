import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { KiroAdapter } from "../../../../src/providers/kiro.js";
import type { ProviderRunEvent } from "../../../../src/providers/types.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-kiro-jsonl.sh");

async function collect<T>(stream: AsyncGenerator<ProviderRunEvent, T>) {
  const events: ProviderRunEvent[] = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

beforeAll(async () => chmod(fixture, 0o755));

describe("Kiro assumption-based subprocess compatibility (opt-in)", () => {
  it("streams content, persists sessions, and reports usage using hypothesized event shapes", async () => {
    const adapter = new KiroAdapter(undefined, { command: fixture, model: "fixture-model" });
    const first = await collect(adapter.run({ input: "first" }));
    const second = await collect(adapter.run({ input: "second", session: first.result.session }));

    expect(first.events.map(({ type }) => type)).toEqual([
      "turn.started", "session.started", "turn.delta", "turn.delta", "usage.updated", "turn.completed",
    ]);
    expect(first.result.text).toBe('hello {"stdin":"first","model":"fixture-model"}');
    expect(first.result.usage).toEqual({ source: "provider", inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(first.result.session.providerSessionId).toBe("fixture-session");
    expect(second.result.text).toContain('"resumed":"fixture-session"');
    expect(second.events.some((event) => event.type === "session.resumed")).toBe(true);
  });

  it("ignores malformed JSONL and unknown events while retaining later hypothesized records", async () => {
    const run = await collect(new KiroAdapter(undefined, { command: fixture }).run({ input: "malformed-and-unknown" }));
    expect(run.result.text).toBe("survived");
    expect(run.events.map(({ type }) => type)).toEqual(["turn.started", "turn.delta", "turn.completed"]);
  });
});
