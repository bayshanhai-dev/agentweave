import type { AgentTurnResult } from "@agentweave/protocol";
import { implementationTriggerMarker } from "./approval-implementation-trigger.js";
import { collaborationStage } from "./collaboration-runtime.js";
import { parseStructuredTurn } from "./structured-turn.js";

type DecisionEvent = {
  id: string;
  type: string;
  message: string;
  agentId?: string;
  taskId?: string;
  correlationId?: string;
  output?: string;
};

type GatedDecisionPayload = {
  agentId: string;
  taskId?: string;
  turnId?: string;
  text?: string;
  structuredResult: AgentTurnResult;
  evidenceIds?: string[];
  provider?: string;
  model?: string;
  usage?: unknown;
};

export type GatedLeadDecision = {
  eventId: string;
  correlationId: string;
  payload: GatedDecisionPayload;
};

type DecisionWorkstream = {
  status: string;
  tasks: Array<{ title: string }>;
  messages: Array<{
    correlationId: string;
    recipientIds: string[];
    content: string;
  }>;
  events: DecisionEvent[];
};

const storedDecisionKind = "gated-lead-decomposition";

function firstBalancedObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0)
      return text.slice(start, index + 1);
  }
  return undefined;
}

function parseStructuredText(text: string): AgentTurnResult | undefined {
  const candidates = [
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1],
    text.trim(),
    firstBalancedObject(text),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return parseStructuredTurn(JSON.parse(candidate));
    } catch {}
  }
  return undefined;
}

/** Recover a completed turn result even when the worker noticed the gate before publishing task.completed. */
export function recoverGatedLeadDecisionPayload(
  events: readonly DecisionEvent[],
  input: {
    agentId: string;
    correlationId?: string;
    taskId?: string;
    turnId?: string;
    text?: string;
    structuredResult?: unknown;
    evidenceIds?: string[];
    provider?: string;
    model?: string;
    usage?: unknown;
  },
): GatedDecisionPayload | undefined {
  if (!input.correlationId) return undefined;
  let structuredResult: AgentTurnResult | undefined;
  if (input.structuredResult !== undefined) {
    try {
      structuredResult = parseStructuredTurn(input.structuredResult);
    } catch {}
  }

  let text = input.text;
  if (!structuredResult) {
    const completedIndex = events.findLastIndex(
      (event) =>
        event.type === "turn.completed" &&
        event.agentId === input.agentId &&
        event.correlationId === input.correlationId,
    );
    if (completedIndex < 0) return undefined;
    const startedIndex = events.findLastIndex(
      (event, index) =>
        index < completedIndex &&
        event.type === "turn.started" &&
        event.agentId === input.agentId &&
        event.correlationId === input.correlationId,
    );
    text = events
      .slice(startedIndex + 1, completedIndex + 1)
      .filter(
        (event) =>
          event.type === "turn.delta" &&
          event.agentId === input.agentId &&
          event.correlationId === input.correlationId,
      )
      .map((event) => event.message)
      .join("");
    structuredResult = parseStructuredText(text);
  }
  if (!structuredResult) return undefined;
  return {
    agentId: input.agentId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(text ? { text } : {}),
    structuredResult,
    ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

export function serializeGatedLeadDecisionPayload(
  payload: GatedDecisionPayload,
): string {
  return JSON.stringify({ kind: storedDecisionKind, schemaVersion: 1, payload });
}

function storedGatedLeadDecision(
  event: DecisionEvent,
): GatedDecisionPayload | undefined {
  if (!event.output) return undefined;
  try {
    const stored = JSON.parse(event.output) as {
      kind?: unknown;
      schemaVersion?: unknown;
      payload?: Partial<GatedDecisionPayload>;
    };
    if (
      stored.kind !== storedDecisionKind ||
      stored.schemaVersion !== 1 ||
      !stored.payload ||
      typeof stored.payload.agentId !== "string"
    )
      return undefined;
    return {
      ...stored.payload,
      agentId: stored.payload.agentId,
      structuredResult: parseStructuredTurn(stored.payload.structuredResult),
    } as GatedDecisionPayload;
  } catch {
    return undefined;
  }
}

export function unappliedGatedLeadDecision(
  workstream: DecisionWorkstream,
  leadAgentId: string,
): GatedLeadDecision | undefined {
  if (
    workstream.status !== "active" ||
    workstream.tasks.some((task) => !collaborationStage(task.title))
  )
    return undefined;
  const appliedCorrelations = new Set(
    workstream.events
      .filter(
        (event) =>
          event.type === "orchestration.gated_decision_applied" &&
          event.correlationId,
      )
      .map((event) => event.correlationId!),
  );
  for (let index = workstream.events.length - 1; index >= 0; index -= 1) {
    const event = workstream.events[index]!;
    if (
      event.type !== "task.gated" ||
      event.agentId !== leadAgentId ||
      !event.correlationId ||
      appliedCorrelations.has(event.correlationId) ||
      !workstream.messages.some(
        (message) =>
          message.correlationId === event.correlationId &&
          message.recipientIds.includes(leadAgentId) &&
          message.content.includes(implementationTriggerMarker),
      )
    )
      continue;
    const payload = storedGatedLeadDecision(event) ?? recoverGatedLeadDecisionPayload(
      workstream.events.slice(0, index),
      {
        agentId: leadAgentId,
        correlationId: event.correlationId,
        ...(event.taskId ? { taskId: event.taskId } : {}),
      },
    );
    if (payload)
      return {
        eventId: event.id,
        correlationId: event.correlationId,
        payload,
      };
  }
  return undefined;
}

/** Replay one held decision through the caller's normal result-application path. */
export async function reconcileGatedLeadDecisionAfterActivation(
  workstream: DecisionWorkstream,
  leadAgentId: string,
  dependencies: {
    applyDecision: (decision: GatedLeadDecision) => Promise<void>;
    decisionApplied: (decision: GatedLeadDecision) => boolean;
    recordApplied: (decision: GatedLeadDecision) => void;
  },
): Promise<boolean> {
  const decision = unappliedGatedLeadDecision(workstream, leadAgentId);
  if (!decision) return false;
  await dependencies.applyDecision(decision);
  if (!dependencies.decisionApplied(decision)) return false;
  dependencies.recordApplied(decision);
  return true;
}
