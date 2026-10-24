import type { AgentTurnResult } from "@agentweave/protocol";
import type { TaskSpec } from "./orchestrator.js";
import {
  extractStructuredTaskSpecs,
  InvalidStructuredTurn,
  parseStructuredTurn,
} from "./structured-turn.js";

type AttemptEvent = {
  type: string;
  message: string;
  correlationId?: string;
  output?: string;
};

const failedAttemptEventTypes = new Set([
  "orchestration.decomposition_failed",
  "orchestration.decomposition_reprompted",
]);

export function decompositionFailureReasonForCorrelation(
  events: readonly AttemptEvent[],
  correlationId: string | undefined,
): string | undefined {
  if (!correlationId) return undefined;
  const failure = [...events].reverse().find(
    (event) =>
      event.correlationId === correlationId &&
      failedAttemptEventTypes.has(event.type),
  );
  return failure?.output?.trim() || failure?.message.trim() || undefined;
}

export function decompositionRejectionFeedback(violations: readonly string[]): {
  eventType: "orchestration.decomposition_rejected";
  eventMessage: string;
  retryInstruction: string;
} {
  const concrete = violations.length
    ? [...violations]
    : ["reply failed structured decomposition validation"];
  return {
    eventType: "orchestration.decomposition_rejected",
    eventMessage: concrete.join("; ").slice(0, 600),
    retryInstruction: `Your previous reply was rejected because:\n- ${concrete.join("\n- ")}\n\nFix exactly these and resend the full JSON.`,
  };
}

export type LateDecompositionOutcome =
  | {
      kind: "applied";
      result: AgentTurnResult;
      specs: TaskSpec[];
      createdTaskCount: number;
    }
  | { kind: "discarded"; violations: string[] };

/** Validate and settle a result whose original decomposition attempt already failed. */
export async function arbitrateLateDecompositionResult(
  input: {
    structuredResult: unknown;
    allowedOwnerRoles: ReadonlySet<string>;
    reviewRole: string;
    originalFailureReason: string;
  },
  dependencies: {
    apply: (result: AgentTurnResult, specs: TaskSpec[]) => Promise<number>;
    emit: (
      type:
        | "orchestration.decomposition_applied_late"
        | "orchestration.decomposition_discarded_late",
      message: string,
    ) => void;
  },
): Promise<LateDecompositionOutcome> {
  let result: AgentTurnResult;
  let specs: TaskSpec[];
  try {
    result = parseStructuredTurn(input.structuredResult);
    specs = extractStructuredTaskSpecs(
      result,
      input.allowedOwnerRoles,
      input.reviewRole,
    );
  } catch (error) {
    const violations = error instanceof InvalidStructuredTurn
      ? error.violations
      : [error instanceof Error ? error.message : String(error)];
    dependencies.emit(
      "orchestration.decomposition_discarded_late",
      `Late decomposition discarded: ${violations.join("; ").slice(0, 560)}`,
    );
    return { kind: "discarded", violations };
  }

  const createdTaskCount = await dependencies.apply(result, specs);
  dependencies.emit(
    "orchestration.decomposition_applied_late",
    `Late decomposition applied after original failure: ${input.originalFailureReason}`.slice(0, 600),
  );
  return { kind: "applied", result, specs, createdTaskCount };
}
