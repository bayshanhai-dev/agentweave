import { describe, expect, it } from "vitest";
import {
  hasStructuredActions,
  parseStructuredTurn,
  planStructuredTurn,
  type TurnContext,
} from "../src/structured-turn.js";

export const context: TurnContext = {
  workstreamId: "ws",
  agentId: "pm",
  turnId: "turn-1",
  correlationId: "correlation",
  agents: [
    { id: "pm", role: "pm", authority: "lead", status: "running" },
    { id: "pe", role: "pe", authority: "reviewer", status: "idle" },
  ],
  tasks: [],
  insights: [],
  evidenceIds: ["1"],
  now: "2026-09-05T00:00:00.000Z",
};
export const result = {
  summary: "Separate document state from rendering",
  insights: [
    { id: "proposal", content: "Separate concerns", evidenceIds: ["1"] },
    {
      id: "critique",
      kind: "critique",
      content: "Also preserve keyboard focus",
      references: ["proposal"],
    },
  ],
  tasks: [{ id: "design", title: "Specify document state", ownerRole: "pe" }],
  messages: [
    {
      recipientRole: "pe",
      content: "Review the state boundary",
      taskId: "design",
    },
  ],
};

describe("structured turn planning", () => {
  it("binds identities to the runtime, resolves local references and addresses the requested task owner", () => {
    const plan = planStructuredTurn(parseStructuredTurn(result), context);
    expect(plan.insights[0]).toMatchObject({
      workstreamId: "ws",
      authorAgentId: "pm",
      lifecycle: "proposed",
    });
    expect(plan.insights[1].references).toEqual([plan.insights[0].id]);
    expect(plan.messages[0]).toMatchObject({
      recipientIds: ["pe"],
      taskId: plan.tasks[0].id,
      causationId: plan.id,
    });
    expect(
      planStructuredTurn(parseStructuredTurn(result), {
        ...context,
        now: "2026-09-06T00:00:00Z",
      }).id,
    ).toBe(plan.id);
    expect(
      planStructuredTurn(parseStructuredTurn(result), {
        ...context,
        agentId: "pe",
      }).id,
    ).not.toBe(plan.id);
  });
  it("rejects unknown recipients, duplicate local IDs, foreign references, and invented evidence", () => {
    for (const invalid of [
      { ...result, messages: [{ recipientRole: "unknown", content: "go" }] },
      { ...result, tasks: [result.tasks[0], result.tasks[0]] },
      {
        ...result,
        insights: [{ id: "x", content: "x", references: ["foreign"] }],
      },
      {
        ...result,
        insights: [{ id: "x", content: "x", evidenceIds: ["999"] }],
      },
      {
        ...result,
        messages: [{ recipientRole: "pm", content: "go", taskId: "design" }],
      },
    ])
      expect(() =>
        planStructuredTurn(parseStructuredTurn(invalid), context),
      ).toThrow();
  });
  it("routes completion and blocking decisions to Human without automatic approval", () => {
    for (const action of ["complete", "wait", "ask_human"]) {
      const plan = planStructuredTurn(
        parseStructuredTurn({
          summary: "done",
          decision: { action, reason: "Review evidence" },
        }),
        context,
      );
      expect(plan.waitingForHuman).toBe(true);
      expect(plan.messages[0].recipientIds).toEqual(["human"]);
      expect(plan.blocked).toBe(action !== "complete");
    }
    expect(() =>
      planStructuredTurn(
        parseStructuredTurn({
          ...result,
          humanBlock: { question: "Which?", context: "Need scope" },
        }),
        context,
      ),
    ).toThrow(/cannot dispatch/);
  });
  it("preserves summary-only compatibility and rejects malformed structured data", () => {
    expect(
      hasStructuredActions(parseStructuredTurn({ summary: "legacy" })),
    ).toBe(false);
    expect(hasStructuredActions(parseStructuredTurn(result))).toBe(true);
    expect(() =>
      parseStructuredTurn({ summary: "bad", messages: "invalid" }),
    ).toThrow(/Invalid AgentTurnResult/);
  });
  it("rejects missing source tasks and binds the retry receipt to its evidence", () => {
    expect(() =>
      planStructuredTurn(parseStructuredTurn(result), {
        ...context,
        taskId: "foreign-task",
      }),
    ).toThrow(/Unknown source task/);
    const summary = parseStructuredTurn({
      summary: "review",
      decision: { action: "complete", reason: "review" },
    });
    expect(planStructuredTurn(summary, context).fingerprint).not.toBe(
      planStructuredTurn(summary, { ...context, evidenceIds: ["2"] })
        .fingerprint,
    );
  });
});
