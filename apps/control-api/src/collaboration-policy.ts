import type { CollaborationRound, Insight } from "@agentweave/domain";

export type CollaborationStopReason =
  | "synthesis_completed"
  | "turn_budget_exhausted"
  | "deadline_exceeded"
  | "novelty_exhausted";
export type CollaborationDecision = {
  accepted: boolean;
  next: "proposal" | "critique" | "synthesis" | "stopped";
  round: CollaborationRound;
  stopReason?: CollaborationStopReason;
  reason: string;
};

const normalized = (content: string) =>
  content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class CollaborationPolicy {
  evaluate(
    round: CollaborationRound,
    existing: Insight[],
    candidate: Insight,
    now = Date.now(),
  ): CollaborationDecision {
    if (
      round.status === "completed" ||
      round.status === "expired" ||
      round.status === "cancelled"
    )
      throw new Error(`Collaboration round is ${round.status}`);
    if (!round.participantAgentIds.includes(candidate.authorAgentId))
      throw new Error("Insight author is not a round participant");
    if (Date.parse(round.deadline) <= now)
      return this.stop(
        round,
        "deadline_exceeded",
        "Collaboration deadline elapsed",
        now,
      );
    if (existing.length >= round.maxTurns)
      return this.stop(
        round,
        "turn_budget_exhausted",
        "Collaboration turn budget exhausted",
        now,
      );
    if (
      existing.some(
        (insight) =>
          normalized(insight.content) === normalized(candidate.content),
      )
    )
      return this.stop(
        round,
        "novelty_exhausted",
        "Candidate repeated an existing insight",
        now,
      );

    const proposals = existing.filter((insight) => insight.kind === "proposal");
    const challenges = existing.filter(
      (insight) =>
        insight.kind === "critique" || insight.kind === "contradiction",
    );
    if (proposals.length < 2 && candidate.kind !== "proposal")
      throw new Error("Two independent proposals are required before critique");
    if (
      proposals.length >= 2 &&
      challenges.length === 0 &&
      !["critique", "contradiction"].includes(candidate.kind)
    )
      throw new Error(
        "A targeted critique or contradiction is required before synthesis",
      );
    if (
      ["critique", "contradiction"].includes(candidate.kind) &&
      !candidate.references.some((id) =>
        proposals.some((proposal) => proposal.id === id),
      ) &&
      !candidate.contradictionOf?.some((id) =>
        proposals.some((proposal) => proposal.id === id),
      )
    )
      throw new Error("A critique must target a proposal");

    const all = [...existing, candidate];
    const updated: CollaborationRound = {
      ...round,
      status: "active",
      insightIds: all.map((insight) => insight.id),
      updatedAt: new Date(now).toISOString(),
    };
    if (candidate.kind === "synthesis") {
      if (candidate.authorAgentId !== round.synthesizerAgentId)
        throw new Error(
          "Only the configured synthesizer may complete the round",
        );
      const supporting = candidate.references.some((id) =>
        all.some((insight) => insight.id === id && insight.kind === "proposal"),
      );
      const opposing = candidate.references.some((id) =>
        all.some(
          (insight) =>
            insight.id === id &&
            ["critique", "contradiction"].includes(insight.kind),
        ),
      );
      if (!supporting || !opposing || candidate.evidenceIds.length === 0)
        throw new Error(
          "Synthesis must cite supporting and opposing insights plus evidence",
        );
      return {
        accepted: true,
        next: "stopped",
        round: { ...updated, status: "completed" },
        stopReason: "synthesis_completed",
        reason: "Evidence-linked synthesis completed the round",
      };
    }
    if (all.length >= round.maxTurns)
      return {
        ...this.stop(
          updated,
          "turn_budget_exhausted",
          "Collaboration turn budget exhausted",
          now,
        ),
        accepted: true,
      };
    const next =
      all.filter((insight) => insight.kind === "proposal").length < 2
        ? "proposal"
        : all.some(
              (insight) =>
                insight.kind === "critique" || insight.kind === "contradiction",
            )
          ? "synthesis"
          : "critique";
    return {
      accepted: true,
      next,
      round: updated,
      reason: `Continue with ${next}`,
    };
  }

  private stop(
    round: CollaborationRound,
    stopReason: CollaborationStopReason,
    reason: string,
    now: number,
  ): CollaborationDecision {
    return {
      accepted: false,
      next: "stopped",
      round: {
        ...round,
        status: "expired",
        updatedAt: new Date(now).toISOString(),
      },
      stopReason,
      reason,
    };
  }
}
