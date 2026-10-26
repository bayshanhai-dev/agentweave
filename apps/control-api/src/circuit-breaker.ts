/**
 * Workstream circuit breaker (#139).
 *
 * The 2026-10-25 runaway burned a full Codex 5-hour window in ~35 minutes:
 * 25 runs and 7.26M input tokens from one workstream, with every individual
 * component behaving "correctly". The trigger load gate (#137) only stops
 * new trigger injections; nothing stopped an orchestrator-driven backlog
 * from feeding itself. This tracker is the workstream-level brake: it
 * watches the live event stream per workstream and, when the trailing
 * window's run count or provider input tokens cross the configured limits,
 * the periodic reconciliation sweep auto-pauses the workstream and emits a
 * loud `workstream.circuit_breaker_tripped` event.
 *
 * Defaults are calibrated on that night's two data points: the storm ran
 * ~2.1M input tokens per 10 minutes, while heavy-but-legitimate work ran
 * ~1.3M per 10 minutes. 1.8M tokens / 10 min trips the former and spares
 * the latter; the run limit (40 / 10 min) is a coarser backstop for
 * zero-token churn loops.
 */
export type CircuitBreakerConfig = {
  windowMs: number;
  maxRuns: number;
  maxInputTokens: number;
};

export const defaultCircuitBreakerConfig: CircuitBreakerConfig = {
  windowMs: 10 * 60_000,
  maxRuns: 40,
  maxInputTokens: 1_800_000,
};

export type CircuitBreakerDecision = {
  message: string;
  runs: number;
  inputTokens: number;
  windowMs: number;
  trippedBy: "runs" | "inputTokens" | "both";
};

type TokenSample = { at: number; inputTokens: number };

/** Pure window evaluation, exported for tests. */
export function evaluateCircuitBreakerWindow(
  runTimes: readonly number[],
  tokenSamples: readonly TokenSample[],
  config: CircuitBreakerConfig,
  now: number,
): CircuitBreakerDecision | undefined {
  const windowStart = now - config.windowMs;
  const runs = runTimes.filter((at) => at > windowStart && at <= now).length;
  const inputTokens = tokenSamples
    .filter((sample) => sample.at > windowStart && sample.at <= now)
    .reduce((sum, sample) => sum + sample.inputTokens, 0);
  const runsTripped = runs > config.maxRuns;
  const tokensTripped = inputTokens > config.maxInputTokens;
  if (!runsTripped && !tokensTripped) return undefined;
  const trippedBy = runsTripped && tokensTripped ? "both" : runsTripped ? "runs" : "inputTokens";
  const windowMinutes = Math.round(config.windowMs / 60_000);
  return {
    runs,
    inputTokens,
    windowMs: config.windowMs,
    trippedBy,
    message:
      `Circuit breaker tripped: ${runs} runs and ${inputTokens.toLocaleString("en-US")} input tokens ` +
      `in the last ${windowMinutes} minutes exceed the limits ` +
      `(${config.maxRuns} runs / ${config.maxInputTokens.toLocaleString("en-US")} input tokens). ` +
      `Workstream auto-paused; review before resuming.`,
  };
}

/**
 * Incremental per-workstream tracker fed from the control API's single
 * event funnel. State is in-memory on purpose: the breaker guards against
 * live burn, and after a process restart the trailing window rebuilds
 * within one window length. Samples are pruned against the configured
 * window on every observe/evaluate so memory stays bounded by the window.
 */
export class CircuitBreakerTracker {
  private readonly runTimes = new Map<string, number[]>();
  private readonly tokenSamples = new Map<string, TokenSample[]>();

  constructor(private readonly config: CircuitBreakerConfig) {}

  observe(
    workstreamId: string,
    event: { type: string; usage?: { inputTokens?: number } },
    now = Date.now(),
  ): void {
    if (event.type === "run.started") {
      const times = this.runTimes.get(workstreamId) ?? [];
      times.push(now);
      this.runTimes.set(workstreamId, this.pruneTimes(times, now));
    }
    if (event.type === "usage.updated" && event.usage?.inputTokens) {
      const samples = this.tokenSamples.get(workstreamId) ?? [];
      samples.push({ at: now, inputTokens: event.usage.inputTokens });
      this.tokenSamples.set(workstreamId, this.pruneSamples(samples, now));
    }
  }

  evaluate(workstreamId: string, now = Date.now()): CircuitBreakerDecision | undefined {
    const times = this.pruneTimes(this.runTimes.get(workstreamId) ?? [], now);
    const samples = this.pruneSamples(this.tokenSamples.get(workstreamId) ?? [], now);
    if (times.length) this.runTimes.set(workstreamId, times);
    else this.runTimes.delete(workstreamId);
    if (samples.length) this.tokenSamples.set(workstreamId, samples);
    else this.tokenSamples.delete(workstreamId);
    return evaluateCircuitBreakerWindow(times, samples, this.config, now);
  }

  clear(workstreamId: string): void {
    this.runTimes.delete(workstreamId);
    this.tokenSamples.delete(workstreamId);
  }

  private pruneTimes(times: number[], now: number): number[] {
    const windowStart = now - this.config.windowMs;
    return times.filter((at) => at > windowStart);
  }

  private pruneSamples(samples: TokenSample[], now: number): TokenSample[] {
    const windowStart = now - this.config.windowMs;
    return samples.filter((sample) => sample.at > windowStart);
  }
}
