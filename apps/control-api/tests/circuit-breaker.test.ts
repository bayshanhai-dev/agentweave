import { describe, expect, it } from "vitest";
import {
  CircuitBreakerTracker,
  defaultCircuitBreakerConfig,
  evaluateCircuitBreakerWindow,
  type CircuitBreakerConfig,
} from "../src/circuit-breaker.js";

const config: CircuitBreakerConfig = {
  windowMs: 10 * 60_000,
  maxRuns: 3,
  maxInputTokens: 1_000,
};
const t0 = 1_000_000_000_000;

describe("circuit breaker window evaluation", () => {
  it("does not trip under the limits", () => {
    const decision = evaluateCircuitBreakerWindow(
      [t0, t0 + 1_000],
      [{ at: t0, inputTokens: 900 }],
      config,
      t0 + 2_000,
    );
    expect(decision).toBeUndefined();
  });

  it("trips when runs exceed the limit inside the window", () => {
    const decision = evaluateCircuitBreakerWindow(
      [t0, t0 + 1, t0 + 2, t0 + 3],
      [],
      config,
      t0 + 4,
    );
    expect(decision?.trippedBy).toBe("runs");
    expect(decision?.runs).toBe(4);
    expect(decision?.message).toContain("auto-paused");
  });

  it("trips when input tokens exceed the limit inside the window", () => {
    const decision = evaluateCircuitBreakerWindow(
      [t0],
      [
        { at: t0, inputTokens: 600 },
        { at: t0 + 5, inputTokens: 500 },
      ],
      config,
      t0 + 10,
    );
    expect(decision?.trippedBy).toBe("inputTokens");
    expect(decision?.inputTokens).toBe(1_100);
  });

  it("ignores samples older than the window", () => {
    const decision = evaluateCircuitBreakerWindow(
      [t0 - config.windowMs - 1, t0],
      [{ at: t0 - config.windowMs - 1, inputTokens: 5_000 }],
      config,
      t0,
    );
    expect(decision).toBeUndefined();
  });

  it("reports both when runs and tokens both trip", () => {
    const decision = evaluateCircuitBreakerWindow(
      [t0, t0 + 1, t0 + 2, t0 + 3],
      [{ at: t0, inputTokens: 2_000 }],
      config,
      t0 + 4,
    );
    expect(decision?.trippedBy).toBe("both");
  });
});

describe("circuit breaker tracker", () => {
  it("accumulates run and usage events per workstream", () => {
    const tracker = new CircuitBreakerTracker(config);
    tracker.observe("ws-a", { type: "run.started" }, t0);
    tracker.observe("ws-a", { type: "usage.updated", usage: { inputTokens: 700 } }, t0 + 1);
    tracker.observe("ws-a", { type: "usage.updated", usage: { inputTokens: 700 } }, t0 + 2);
    tracker.observe("ws-b", { type: "run.started" }, t0);
    expect(tracker.evaluate("ws-a", t0 + 3)?.inputTokens).toBe(1_400);
    expect(tracker.evaluate("ws-b", t0 + 3)).toBeUndefined();
  });

  it("ignores unrelated events and usage without input tokens", () => {
    const tracker = new CircuitBreakerTracker(config);
    tracker.observe("ws-a", { type: "turn.started" }, t0);
    tracker.observe("ws-a", { type: "usage.updated", usage: {} }, t0);
    tracker.observe("ws-a", { type: "usage.updated" }, t0);
    expect(tracker.evaluate("ws-a", t0 + 1)).toBeUndefined();
  });

  it("forgets samples as the window slides and after clear", () => {
    const tracker = new CircuitBreakerTracker(config);
    for (let i = 0; i < 4; i += 1) tracker.observe("ws-a", { type: "run.started" }, t0 + i);
    expect(tracker.evaluate("ws-a", t0 + 5)?.trippedBy).toBe("runs");
    expect(tracker.evaluate("ws-a", t0 + config.windowMs + 5)).toBeUndefined();
    tracker.observe("ws-a", { type: "usage.updated", usage: { inputTokens: 2_000 } }, t0);
    tracker.clear("ws-a");
    expect(tracker.evaluate("ws-a", t0 + 1)).toBeUndefined();
  });

  it("default config matches the calibrated storm thresholds", () => {
    // Storm: ~2.1M input tokens per 10 min must trip; heavy legit work at
    // ~1.3M per 10 min must not.
    const storm = evaluateCircuitBreakerWindow(
      [],
      [{ at: t0, inputTokens: 2_100_000 }],
      defaultCircuitBreakerConfig,
      t0 + 1,
    );
    const legit = evaluateCircuitBreakerWindow(
      [],
      [{ at: t0, inputTokens: 1_300_000 }],
      defaultCircuitBreakerConfig,
      t0 + 1,
    );
    expect(storm?.trippedBy).toBe("inputTokens");
    expect(legit).toBeUndefined();
  });
});
