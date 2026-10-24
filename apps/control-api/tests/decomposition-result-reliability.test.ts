import { describe, expect, it, vi } from "vitest";
import {
  arbitrateLateDecompositionResult,
  decompositionFailureReasonForCorrelation,
  decompositionRejectionFeedback,
} from "../src/decomposition-result-reliability.js";
import {
  extractStructuredTaskSpecs,
  InvalidStructuredTurn,
  parseStructuredTurn,
} from "../src/structured-turn.js";

const roles = new Set(["showrunner", "writer", "reviewer"]);
const validResult = {
  schemaVersion: 1,
  summary: "Produce the article",
  insights: [],
  messages: [],
  tasks: [{
    id: "draft",
    title: "Draft the article",
    ownerRole: "writer",
    acceptanceCriteria: ["The article is clear to its intended reader"],
  }],
};

describe("decomposition rejection feedback", () => {
  it("produces a rejection event and retry instruction with the exact concrete violations", () => {
    let violations: string[] = [];
    try {
      extractStructuredTaskSpecs(
        parseStructuredTurn({ ...validResult, tasks: [] }),
        roles,
        "reviewer",
      );
    } catch (error) {
      if (!(error instanceof InvalidStructuredTurn)) throw error;
      violations = error.violations;
    }

    const feedback = decompositionRejectionFeedback(violations);
    const event = {
      type: feedback.eventType,
      message: feedback.eventMessage,
    };
    const retryPrompt = `${feedback.retryInstruction}\n\nGeneric decomposition specification`;

    expect(event).toEqual({
      type: "orchestration.decomposition_rejected",
      message: "tasks empty (expected between 1 and 12 tasks)",
    });
    expect(retryPrompt).toContain(
      "Your previous reply was rejected because:\n- tasks empty (expected between 1 and 12 tasks)\n\nFix exactly these and resend the full JSON.",
    );
    expect(retryPrompt.indexOf("tasks empty")).toBeLessThan(
      retryPrompt.indexOf("Generic decomposition specification"),
    );
  });
});

describe("late decomposition arbitration", () => {
  it("finds the original failure by correlation, creates valid tasks, and emits late-applied", async () => {
    const failureReason = "no turn.started or result within 600 seconds for message retry-1";
    const events = [{
      type: "orchestration.decomposition_reprompted",
      message: "PM decomposition re-prompted (attempt 1)",
      correlationId: "slow-turn",
      output: failureReason,
    }];
    const tasks: Array<{ title: string }> = [];
    const emitted: Array<{ type: string; message: string }> = [];
    const apply = vi.fn(async (_result, specs) => {
      tasks.push(...specs.map((spec) => ({ title: spec.title })));
      return specs.length;
    });

    const outcome = await arbitrateLateDecompositionResult({
      structuredResult: validResult,
      allowedOwnerRoles: roles,
      reviewRole: "reviewer",
      originalFailureReason: decompositionFailureReasonForCorrelation(events, "slow-turn")!,
    }, {
      apply,
      emit: (type, message) => emitted.push({ type, message }),
    });

    expect(outcome.kind).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
    expect(tasks.map((task) => task.title)).toEqual([
      "Draft the article",
      "Final validation: run the full project suite",
    ]);
    expect(emitted).toEqual([{
      type: "orchestration.decomposition_applied_late",
      message: `Late decomposition applied after original failure: ${failureReason}`,
    }]);
    expect(emitted.some((event) => event.type === "task.gated")).toBe(false);
  });

  it("discards an invalid late result with indexed violations and no gated orphan", async () => {
    const emitted: Array<{ type: string; message: string }> = [];
    const apply = vi.fn(async () => 0);

    const outcome = await arbitrateLateDecompositionResult({
      structuredResult: {
        ...validResult,
        tasks: [{
          ...validResult.tasks[0],
          acceptanceCriteria: ["TBD"],
        }],
      },
      allowedOwnerRoles: roles,
      reviewRole: "reviewer",
      originalFailureReason: "slow result",
    }, {
      apply,
      emit: (type, message) => emitted.push({ type, message }),
    });

    expect(outcome).toEqual({
      kind: "discarded",
      violations: ['tasks[0].acceptanceCriteria[0] placeholder "TBD"'],
    });
    expect(apply).not.toHaveBeenCalled();
    expect(emitted).toEqual([{
      type: "orchestration.decomposition_discarded_late",
      message: 'Late decomposition discarded: tasks[0].acceptanceCriteria[0] placeholder "TBD"',
    }]);
    expect(emitted.some((event) => event.type === "task.gated")).toBe(false);
  });
});
