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

/** Validate one untrusted Kiro stream-json record. Unknown shapes are ignored. */
export function normalizeKiroRecord(value: unknown): KiroNormalizedEvent | undefined {
  const record = object(value);
  const type = record && nonEmptyString(record.type);
  if (!record || !type) return undefined;
  const data = dataFor(record);

  if (type === "content" || type === "content.delta") {
    const text = nonEmptyString(data.text) ?? nonEmptyString(data.content);
    return text === undefined ? undefined : { type: "content", text };
  }
  if (type === "completion" || type === "completed") {
    const text = nonEmptyString(data.text) ?? nonEmptyString(data.content);
    return { type: "completion", ...(text !== undefined ? { text } : {}) };
  }
  if (type === "error" || type === "interruption") {
    const error = object(data.error);
    const message = nonEmptyString(data.message) ?? nonEmptyString(error?.message);
    if (message === undefined) return undefined;
    const code = nonEmptyString(data.code) ?? nonEmptyString(error?.code);
    return { type: "error", message, ...(code !== undefined ? { code } : {}) };
  }
  if (type === "session" || type === "session.started" || type === "session.created") {
    const sessionId = nonEmptyString(data.sessionId) ?? nonEmptyString(data.session_id);
    return sessionId === undefined ? undefined : { type: "session", sessionId };
  }
  if (type === "usage" || type === "usage.updated") {
    const usage = usageFrom(data.usage ?? data);
    return usage === undefined ? undefined : { type: "usage", usage };
  }
  return undefined;
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
        const normalized = normalizeKiroRecord(JSON.parse(line));
        if (normalized) yield normalized;
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
