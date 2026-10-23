import type { ProviderUsage } from "./types.js";

export type KiroNormalizedEvent =
  | { type: "content"; text: string }
  | { type: "completion"; text?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "session"; sessionId: string }
  | { type: "usage"; usage: ProviderUsage };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function dataFor(record: JsonObject): JsonObject {
  return object(record.data) ?? record;
}

function usageFrom(value: unknown): ProviderUsage | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const inputTokens = nonNegativeNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = nonNegativeNumber(usage.outputTokens ?? usage.output_tokens);
  const totalTokens = nonNegativeNumber(usage.totalTokens ?? usage.total_tokens);
  const costUsd = nonNegativeNumber(usage.costUsd ?? usage.cost_usd);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && costUsd === undefined) return undefined;
  return {
    source: "provider",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Kiro bills in credits, not tokens: its usage payloads carry `creditsUsed`
 * (possibly nested under a `meteringUsage` object, or as a bare metering
 * number). Report credits as credits — never relabel them as tokens or USD.
 */
function creditsFrom(value: unknown): number | undefined {
  const direct = nonNegativeNumber(value);
  if (direct !== undefined) return direct;
  const record = object(value);
  if (!record) return undefined;
  return (
    nonNegativeNumber(record.creditsUsed ?? record.credits_used ?? record.credits) ??
    creditsFrom(record.meteringUsage)
  );
}

function usageWithCredits(value: unknown): ProviderUsage | undefined {
  const tokens = usageFrom(value);
  const credits = creditsFrom(value) ?? creditsFrom(object(value ?? {})?.meteringUsage);
  if (!tokens && credits === undefined) return undefined;
  return { ...(tokens ?? { source: "provider" as const }), ...(credits !== undefined ? { credits } : {}) };
}

/** Find a usage payload wherever this record shape keeps it. */
function findUsage(record: JsonObject): ProviderUsage | undefined {
  const candidates: unknown[] = [
    record.usage,
    dataFor(record).usage,
    object(record.metadata)?.usage,
    object(record.runFinished)?.usage,
    object(record.result)?.usage,
    record.meteringUsage,
    dataFor(record).meteringUsage,
    object(record.runFinished)?.meteringUsage,
  ];
  for (const candidate of candidates) {
    const usage = usageWithCredits(candidate);
    if (usage) return usage;
  }
  return undefined;
}

function sessionIdFrom(record: JsonObject): string | undefined {
  return (
    nonEmptyString(record.sessionId) ??
    nonEmptyString(record.session_id) ??
    nonEmptyString(object(record.params)?.sessionId) ??
    nonEmptyString(object(record.result)?.sessionId) ??
    nonEmptyString(dataFor(record).sessionId) ??
    nonEmptyString(dataFor(record).session_id)
  );
}

/** Text of an ACP content block ({ type: "text", text }) or a plain string. */
function acpText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  const block = object(value);
  return block ? nonEmptyString(block.text) : undefined;
}

/**
 * One ACP session-update (JSON-RPC `session/update` params, or the flattened
 * `{ sessionUpdate, content, sessionId }` line shape): only the agent's
 * message chunks are user-visible text. Thought chunks, tool calls and plan
 * updates are machinery and are not surfaced as content.
 */
function acpUpdateEvents(update: JsonObject | undefined, sessionId: string | undefined): KiroNormalizedEvent[] {
  const events: KiroNormalizedEvent[] = [];
  if (sessionId) events.push({ type: "session", sessionId });
  if (!update) return events;
  const kind = nonEmptyString(update.sessionUpdate);
  if (kind === "agent_message_chunk") {
    const text = acpText(update.content);
    if (text !== undefined) events.push({ type: "content", text });
  }
  return events;
}

function runFinishedEvents(finished: JsonObject): KiroNormalizedEvent[] {
  const events: KiroNormalizedEvent[] = [];
  const usage = usageWithCredits(finished.usage) ?? usageWithCredits(finished.meteringUsage);
  if (usage) events.push({ type: "usage", usage });
  const text = nonEmptyString(finished.finalText);
  events.push({ type: "completion", ...(text !== undefined ? { text } : {}) });
  return events;
}

function runErrorEvent(value: unknown): KiroNormalizedEvent | undefined {
  if (typeof value === "string" && value) return { type: "error", message: value };
  const record = object(value);
  if (!record) return undefined;
  const error = object(record.error);
  const message = nonEmptyString(record.message) ?? nonEmptyString(error?.message) ?? nonEmptyString(record.error as unknown);
  if (message === undefined) return undefined;
  const code = nonEmptyString(record.code) ?? nonEmptyString(error?.code);
  return { type: "error", message, ...(code !== undefined ? { code } : {}) };
}

/**
 * Validate one untrusted Kiro stream-json record. Unknown shapes are ignored.
 *
 * kiro-cli 2.x `--output-format stream-json` emits the run's ACP events
 * (Agent Client Protocol), not the flat `{ type: "content" }` records the
 * first adapter assumed from the headless docs: session updates arrive as
 * JSON-RPC `session/update` notifications whose `sessionUpdate` kind carries
 * the text, the run terminates with `runFinished` / `runError`, and usage is
 * reported in credits. All of those shapes — plus the originally assumed
 * flat records, which the evidence fixtures use — are normalized here.
 */
export function normalizeKiroRecord(value: unknown): KiroNormalizedEvent[] {
  const record = object(value);
  if (!record) return [];

  // Run-level terminal events (keyed shape, as emitted by kiro-cli 2.33).
  const finished = object(record.runFinished);
  if (finished) return runFinishedEvents(finished);
  if (record.runError !== undefined) {
    const error = runErrorEvent(record.runError);
    if (error) return [error];
  }

  // ACP JSON-RPC shapes.
  if (record.method === "session/update") {
    const params = object(record.params);
    return acpUpdateEvents(params ? object(params.update) : undefined, sessionIdFrom(record));
  }
  if (typeof record.sessionUpdate === "string") {
    // Flattened session-update line: { sessionUpdate, content, sessionId }.
    return acpUpdateEvents(record, sessionIdFrom(record));
  }
  const result = object(record.result);
  if (result && nonEmptyString(result.stopReason)) {
    const events: KiroNormalizedEvent[] = [];
    const usage = findUsage(record);
    if (usage) events.push({ type: "usage", usage });
    const sessionId = sessionIdFrom(record);
    if (sessionId) events.push({ type: "session", sessionId });
    events.push({ type: "completion" });
    return events;
  }

  // Run-level terminal events (type-tagged shape).
  const type = nonEmptyString(record.type);
  if (type === "runFinished" || type === "run_finished") return runFinishedEvents(record);
  if (type === "runError" || type === "run_error") {
    const error = runErrorEvent(record);
    return error ? [error] : [];
  }

  // Originally assumed flat records.
  if (!type) return [];
  const data = dataFor(record);
  if (type === "content" || type === "content.delta") {
    const text = nonEmptyString(data.text) ?? nonEmptyString(data.content);
    return text === undefined ? [] : [{ type: "content", text }];
  }
  if (type === "completion" || type === "completed") {
    const text = nonEmptyString(data.text) ?? nonEmptyString(data.content);
    return [{ type: "completion", ...(text !== undefined ? { text } : {}) }];
  }
  if (type === "error" || type === "interruption") {
    const error = runErrorEvent(data);
    return error ? [error] : [];
  }
  if (type === "session" || type === "session.started" || type === "session.created") {
    const sessionId = sessionIdFrom(record);
    return sessionId === undefined ? [] : [{ type: "session", sessionId }];
  }
  if (type === "usage" || type === "usage.updated") {
    const usage = usageWithCredits(data.usage ?? data);
    return usage === undefined ? [] : [{ type: "usage", usage }];
  }
  return [];
}

/**
 * Incrementally decode Kiro JSONL. Only the current incomplete line is retained;
 * malformed lines and an invalid unterminated final line are safely discarded.
 */
export async function* normalizeKiroJsonl(chunks: AsyncIterable<string | Uint8Array>): AsyncGenerator<KiroNormalizedEvent> {
  const maxLineLength = 1024 * 1024;
  const decoder = new TextDecoder();
  let pending = "";
  let discardingOversizedLine = false;
  const consume = function* (lines: string[]): Generator<KiroNormalizedEvent> {
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        yield* normalizeKiroRecord(JSON.parse(line));
      } catch { /* A subprocess line is untrusted input; skip it. */ }
    }
  };

  for await (const chunk of chunks) {
    let decoded = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (discardingOversizedLine) {
      const newline = decoded.indexOf("\n");
      if (newline < 0) continue;
      decoded = decoded.slice(newline + 1);
      discardingOversizedLine = false;
    }
    pending += decoded;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    yield* consume(lines.filter((line) => line.length <= maxLineLength));
    if (pending.length > maxLineLength) { pending = ""; discardingOversizedLine = true; }
  }
  pending += decoder.decode();
  if (!discardingOversizedLine && pending.length > 0 && pending.length <= maxLineLength) yield* consume([pending]);
}
