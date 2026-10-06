import { describe, expect, it } from "vitest";
import type { Insight } from "@agentweave/domain";
import { CollaborationPolicy } from "../src/collaboration-policy.js";
import { createCollaborationRound, dispatchForDecision } from "../src/collaboration-runtime.js";
import { roundFrom } from "../src/repositories/insight-repository.js";

const agents = [
  { id: "pm-1", role: "pm", authority: "lead" as const },
  { id: "backend-1", role: "backend", authority: "executor" as const },
  { id: "frontend-1", role: "frontend", authority: "executor" as const },
  { id: "qa-1", role: "qa", authority: "reviewer" as const },
];
const insight = (id: string, kind: Insight["kind"], authorAgentId: string, references: string[] = []): Insight => ({
  id, workstreamId: "ws-1", kind, lifecycle: "accepted", authorAgentId,
  content: `${kind} ${id}`, confidence: 0.8, references, evidenceIds: kind === "synthesis" ? ["1"] : [],
  createdAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z",
});

describe("agent-owned collaboration runtime", () => {
  it("restores JSONB arrays returned as serialized strings", () => {
    expect(roundFrom({ id: "r", workstream_id: "ws-1", topic: "t", participant_agent_ids: '["pm-1","qa-1"]', synthesizer_agent_id: "pm-1", max_turns: 4, deadline: "2026-10-02T13:00:00.000Z", completion_rule: "human_approval", status: "active", insight_ids: '["p1"]', created_at: "2026-10-02T12:00:00.000Z", updated_at: "2026-10-02T12:00:00.000Z" })).toMatchObject({ participantAgentIds: ["pm-1", "qa-1"], insightIds: ["p1"] });
  });

  it("dispatches two independent proposals, one critique, then lead synthesis", () => {
    const { round, dispatches } = createCollaborationRound("ws-1", "Ship a useful demo", agents, new Date("2026-10-02T12:00:00.000Z"));
    expect(dispatches.map((item) => item.agentId)).toEqual(["backend-1", "frontend-1"]);
    expect(new Set(dispatches.map((item) => item.key)).size).toBe(2);

    const policy = new CollaborationPolicy();
    const proposals = [insight("p1", "proposal", "backend-1"), insight("p2", "proposal", "frontend-1")];
    const critiqueDecision = policy.evaluate({ ...round, insightIds: ["p1"] }, [proposals[0]!], proposals[1]!, Date.parse("2026-10-02T12:01:00.000Z"));
    expect(dispatchForDecision(critiqueDecision, proposals, agents)).toMatchObject({ stage: "critique", agentId: "qa-1" });

    const critique = insight("c1", "critique", "qa-1", ["p1", "p2"]);
    const synthesisDecision = policy.evaluate(critiqueDecision.round, proposals, critique, Date.parse("2026-10-02T12:02:00.000Z"));
    const synthesis = dispatchForDecision(synthesisDecision, [...proposals, critique], agents);
    expect(synthesis).toMatchObject({ stage: "synthesis", agentId: "pm-1" });
    expect(synthesis?.prompt).toContain('references ["p1","c1"]');
  });
});
