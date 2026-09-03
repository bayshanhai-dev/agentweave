import { describe, expect, it } from "vitest";
import { validateCollaborationRound, validateInsight, type CollaborationRound, type Insight } from "../src/index.js";

const insight = (overrides: Partial<Insight> = {}): Insight => ({ id: "i-proposal", workstreamId: "ws-1", kind: "proposal", lifecycle: "proposed", authorAgentId: "pm-1", content: "Use a bounded review round", confidence: 0.8, references: [], evidenceIds: [], createdAt: "2026-12-01T00:00:00.000Z", updatedAt: "2026-12-01T00:00:00.000Z", ...overrides });
const round = (overrides: Partial<CollaborationRound> = {}): CollaborationRound => ({ id: "r-1", workstreamId: "ws-1", topic: "Review proposal", participantAgentIds: ["pm-1", "qa-1"], synthesizerAgentId: "pm-1", maxTurns: 4, deadline: "2099-12-01T00:00:00.000Z", completionRule: "synthesizer", status: "proposed", insightIds: [], createdAt: "2026-12-01T00:00:00.000Z", updatedAt: "2026-12-01T00:00:00.000Z", ...overrides });

describe("Insight and CollaborationRound contracts", () => {
  it("accepts proposal, critique, contradiction, synthesis, and supersession relationships", () => {
    const ids = new Set(["i-proposal", "i-critique", "i-contradiction", "i-synthesis"]);
    validateInsight(insight());
    validateInsight(insight({ id: "i-critique", kind: "critique", references: ["i-proposal"] }), ids);
    validateInsight(insight({ id: "i-contradiction", kind: "contradiction", contradictionOf: ["i-proposal"] }), ids);
    validateInsight(insight({ id: "i-synthesis", kind: "synthesis", references: ["i-critique", "i-contradiction"] }), ids);
    validateInsight(insight({ id: "i-replacement", lifecycle: "superseded", supersedes: ["i-proposal"] }), ids);
  });

  it("rejects invalid confidence, references, and lifecycle relationships", () => {
    expect(() => validateInsight(insight({ confidence: 1.1 }))).toThrow(/confidence/);
    expect(() => validateInsight(insight({ references: ["missing"] }), new Set())).toThrow(/does not exist/);
    expect(() => validateInsight(insight({ kind: "contradiction" }))).toThrow(/Contradiction/);
    expect(() => validateInsight(insight({ lifecycle: "superseded" }))).toThrow(/Superseded/);
  });

  it("requires bounded rounds with a participating synthesizer", () => {
    validateCollaborationRound(round());
    expect(() => validateCollaborationRound(round({ synthesizerAgentId: "unknown" }))).toThrow(/participant/);
    expect(() => validateCollaborationRound(round({ maxTurns: 0 }))).toThrow(/maxTurns/);
    expect(() => validateCollaborationRound(round({ insightIds: ["missing"] }))).toThrow(/does not exist/);
  });
});
