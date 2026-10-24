import { createHash } from "node:crypto";
import type { CollaborationRound, Insight } from "@agentweave/domain";
import type { CollaborationDecision } from "./collaboration-policy.js";

export type CollaborationAgent = {
  id: string;
  role: string;
  authority: "lead" | "reviewer" | "executor";
};

export type CollaborationDispatch = {
  key: string;
  stage: "proposal" | "critique" | "synthesis";
  agentId: string;
  role: string;
  title: string;
  prompt: string;
};

const marker = (
  roundId: string,
  stage: CollaborationDispatch["stage"],
  key: string,
) =>
  `[agentweave collaboration=${encodeURIComponent(roundId)} stage=${stage} key=${encodeURIComponent(key)}]`;

const resultContract = `Return only one JSON object with schemaVersion 1, summary, insights, tasks, and messages. Do not wrap it in markdown. Each insight is an object with: "id" (string), "kind", "content" — the full narrative text MUST be in the field named "content" (not "text", "body", or "message"; a reply whose narrative is in any other field is rejected), "confidence" (number 0-1), "references" (array of insight ids), "contradictionOf" (array of insight ids), and "evidenceIds" (array of evidence ids).`;

const proposalDispatch = (
  round: CollaborationRound,
  agent: CollaborationAgent,
  index: number,
): CollaborationDispatch => {
  const key = `proposal-${index + 1}`;
  return {
    key,
    stage: "proposal",
    agentId: agent.id,
    role: agent.role,
    title: `Independent proposal from ${agent.role}`,
    prompt: `${marker(round.id, "proposal", key)}\nIndependently propose the best approach to this goal. Do not copy or wait for another Agent. Explain the useful insight and assumptions.\n\nGoal: ${round.topic}\n\n${resultContract}\nThe insights array must contain exactly one proposal with id "${key}", kind "proposal", confidence, empty references, empty contradictionOf, and empty evidenceIds. Keep tasks and messages empty.`,
  };
};

const critiqueDispatch = (
  round: CollaborationRound,
  insights: Insight[],
  reviewer: CollaborationAgent,
): CollaborationDispatch => {
  const proposals = insights.filter((insight) => insight.kind === "proposal");
  const references = proposals.map((insight) => insight.id);
  return {
    key: "critique",
    stage: "critique",
    agentId: reviewer.id,
    role: reviewer.role,
    title: "Challenge the independent proposals",
    prompt: `${marker(round.id, "critique", "critique")}\nCompare the proposals below. Identify a concrete weakness, conflict, or missing evidence.\n\n${proposals.map((item) => `${item.id}: ${item.content}`).join("\n")}\n\n${resultContract}\nThe insights array must contain exactly one critique with id "critique", kind "critique", confidence, references ${JSON.stringify(references)}, empty contradictionOf, and empty evidenceIds. Keep tasks and messages empty.`,
  };
};

const synthesisDispatch = (
  round: CollaborationRound,
  insights: Insight[],
  lead: CollaborationAgent,
): CollaborationDispatch => {
  const proposal = insights.find((insight) => insight.kind === "proposal");
  const challenge = insights.find((insight) =>
    ["critique", "contradiction"].includes(insight.kind),
  );
  if (!proposal || !challenge)
    throw new Error("Synthesis requires a proposal and a challenge");
  const references = [proposal.id, challenge.id];
  return {
    key: "synthesis",
    stage: "synthesis",
    agentId: lead.id,
    role: lead.role,
    title: "Synthesize the strongest evidence-backed outcome",
    prompt: `${marker(round.id, "synthesis", "synthesis")}\nSynthesize the strongest conclusion from the accepted proposals and critique. Resolve the disagreement explicitly and explain why the result is stronger than either proposal alone.\n\n${insights.map((item) => `${item.kind} ${item.id}: ${item.content}`).join("\n")}\n\n${resultContract}\nThe insights array must contain exactly one synthesis with id "synthesis", kind "synthesis", confidence, references ${JSON.stringify(references)}, empty contradictionOf, and empty evidenceIds. Also include completionProposal with a concise reason and empty evidenceIds. Keep tasks and messages empty. The runtime attaches verified task evidence.`,
  };
};

export function createCollaborationRound(
  workstreamId: string,
  topic: string,
  agents: CollaborationAgent[],
  now = new Date(),
): { round: CollaborationRound; dispatches: CollaborationDispatch[] } {
  const lead = agents.find((agent) => agent.authority === "lead");
  const reviewer = agents.find((agent) => agent.authority === "reviewer");
  const proposers = agents
    .filter((agent) => agent.authority === "executor")
    .slice(0, 2);
  if (!lead || !reviewer || proposers.length < 2)
    throw new Error(
      "Agent-owned collaboration requires one lead, one reviewer, and two executors",
    );
  const id = `${workstreamId}:round:${createHash("sha256").update(topic).digest("hex").slice(0, 12)}`;
  const timestamp = now.toISOString();
  const participants = [...proposers, reviewer, lead];
  const round: CollaborationRound = {
    id,
    workstreamId,
    topic,
    participantAgentIds: participants.map((agent) => agent.id),
    synthesizerAgentId: lead.id,
    maxTurns: 4,
    deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
    completionRule: "human_approval",
    status: "active",
    insightIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    round,
    dispatches: proposers.map((agent, index) =>
      proposalDispatch(round, agent, index),
    ),
  };
}

/** Reconstructs the missing turn(s) for the round's current stage. */
export function expectedCollaborationDispatches(
  round: CollaborationRound,
  insights: Insight[],
  agents: CollaborationAgent[],
): CollaborationDispatch[] {
  if (round.status !== "active") return [];
  const participants = round.participantAgentIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is CollaborationAgent => Boolean(agent));
  const selected = insights.filter((insight) =>
    round.insightIds.includes(insight.id),
  );
  if (selected.some((insight) => insight.kind === "synthesis")) return [];

  const proposers = participants
    .filter((agent) => agent.authority === "executor")
    .slice(0, 2);
  const proposalAuthors = new Set(
    selected
      .filter((insight) => insight.kind === "proposal")
      .map((insight) => insight.authorAgentId),
  );
  const missingProposals = proposers
    .map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => !proposalAuthors.has(agent.id));
  if (missingProposals.length)
    return missingProposals.map(({ agent, index }) =>
      proposalDispatch(round, agent, index),
    );

  if (
    !selected.some((insight) =>
      ["critique", "contradiction"].includes(insight.kind),
    )
  ) {
    const reviewer = participants.find(
      (agent) => agent.authority === "reviewer",
    );
    if (!reviewer) throw new Error("Collaboration reviewer is unavailable");
    return [critiqueDispatch(round, selected, reviewer)];
  }

  const lead = participants.find(
    (agent) => agent.id === round.synthesizerAgentId,
  );
  if (!lead) throw new Error("Collaboration synthesizer is unavailable");
  return [synthesisDispatch(round, selected, lead)];
}

export function dispatchForDecision(
  decision: CollaborationDecision,
  insights: Insight[],
  agents: CollaborationAgent[],
): CollaborationDispatch | undefined {
  if (decision.next === "stopped" || decision.next === "proposal") return;
  const round = decision.round;
  const selected = insights.filter((insight) =>
    round.insightIds.includes(insight.id),
  );
  if (decision.next === "critique") {
    const reviewer = agents.find((agent) => agent.authority === "reviewer");
    if (!reviewer) throw new Error("Collaboration reviewer is unavailable");
    return critiqueDispatch(round, selected, reviewer);
  }
  const lead = agents.find((agent) => agent.id === round.synthesizerAgentId);
  if (!lead) throw new Error("Collaboration synthesizer is unavailable");
  return synthesisDispatch(round, selected, lead);
}

export function collaborationStage(title: string) {
  return title.startsWith("[Collaboration:proposal]")
    ? "proposal"
    : title.startsWith("[Collaboration:critique]")
      ? "critique"
      : title.startsWith("[Collaboration:synthesis]")
        ? "synthesis"
        : undefined;
}
