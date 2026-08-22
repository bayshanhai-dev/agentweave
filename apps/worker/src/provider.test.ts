import { describe, expect, it } from "vitest";
import { MockProvider, type ProviderEvent } from "./provider.js";

async function collect<T>(stream: AsyncGenerator<ProviderEvent, T>): Promise<{ events: ProviderEvent[]; result: T }> {
  const events: ProviderEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, result: step.value };
}

describe("MockProvider", () => {
  it("creates resumable sessions and emits streaming completion events", async () => {
    const provider = new MockProvider();
    const session = await provider.create("pm", "session-1");
    expect(await provider.resume(session)).toEqual(session);
    const run = await collect(provider.send(session, "ship it"));
    expect(run.events.map((event) => event.type)).toEqual(["turn.started", "turn.delta", "turn.delta", "turn.delta", "turn.completed"]);
    expect(run.result.metadata.nextRole).toBe("pe");
  });

  it("supports a deterministic QA failure path", async () => {
    const provider = new MockProvider(true);
    const session = await provider.create("qa", "session-qa");
    const run = await collect(provider.send(session, "task-1"));
    expect(run.result.metadata.outcome).toBe("fail");
    expect(run.result.text).toContain("fail");
  });

  it("emits cancellation events", async () => {
    const provider = new MockProvider();
    const session = await provider.create("coder", "session-coder");
    const events = await collect(provider.cancel(session, "turn-1"));
    expect(events.events).toEqual([{ type: "turn.cancelled", turnId: "turn-1" }]);
  });
});
