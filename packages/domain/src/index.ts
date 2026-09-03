export const workstreamStatuses = [
  "draft",
  "starting",
  "active",
  "waiting_for_human",
  "pausing",
  "paused",
  "resuming",
  "completing",
  "completed",
  "emergency_stopped",
  "archived",
] as const;

export type WorkstreamStatus = (typeof workstreamStatuses)[number];

const transitions: Record<WorkstreamStatus, readonly WorkstreamStatus[]> = {
  draft: ["starting", "archived"],
  starting: ["active", "pausing"],
  active: ["waiting_for_human", "pausing", "completing"],
  waiting_for_human: ["active", "pausing", "completing"],
  pausing: ["paused"],
  paused: ["resuming", "archived"],
  resuming: ["active", "waiting_for_human", "pausing"],
  completing: ["active", "completed"],
  completed: ["active", "archived"],
  emergency_stopped: ["archived"],
  archived: [],
};

export function canTransition(from: WorkstreamStatus, to: WorkstreamStatus): boolean {
  return transitions[from].includes(to);
}

export const insightKinds = ["proposal", "critique", "contradiction", "synthesis"] as const;
export type InsightKind = (typeof insightKinds)[number];
export const insightLifecycles = ["proposed", "accepted", "rejected", "superseded"] as const;
export type InsightLifecycle = (typeof insightLifecycles)[number];

export type Insight = {
  id: string;
  workstreamId: string;
  kind: InsightKind;
  lifecycle: InsightLifecycle;
  authorAgentId: string;
  content: string;
  confidence: number;
  references: string[];
  contradictionOf?: string[];
  supersedes?: string[];
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export const collaborationRoundStatuses = ["proposed", "active", "completed", "expired", "cancelled"] as const;
export type CollaborationRoundStatus = (typeof collaborationRoundStatuses)[number];
export type CollaborationRound = {
  id: string;
  workstreamId: string;
  topic: string;
  participantAgentIds: string[];
  synthesizerAgentId: string;
  maxTurns: number;
  deadline: string;
  completionRule: "all_participants" | "synthesizer" | "human_approval";
  status: CollaborationRoundStatus;
  insightIds: string[];
  createdAt: string;
  updatedAt: string;
};

const isIsoDate = (value: string) => !Number.isNaN(Date.parse(value));
const hasText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function validateInsight(insight: Insight, knownInsightIds: ReadonlySet<string> = new Set()): void {
  if (!hasText(insight.id) || !hasText(insight.workstreamId) || !hasText(insight.authorAgentId) || !hasText(insight.content)) throw new Error("Insight identity and content are required");
  if (!insightKinds.includes(insight.kind)) throw new Error(`Unsupported insight kind: ${insight.kind}`);
  if (!insightLifecycles.includes(insight.lifecycle)) throw new Error(`Unsupported insight lifecycle: ${insight.lifecycle}`);
  if (!Number.isFinite(insight.confidence) || insight.confidence < 0 || insight.confidence > 1) throw new Error("Insight confidence must be between 0 and 1");
  if (!isIsoDate(insight.createdAt) || !isIsoDate(insight.updatedAt)) throw new Error("Insight timestamps must be ISO dates");
  for (const reference of [...insight.references, ...(insight.contradictionOf ?? []), ...(insight.supersedes ?? [])]) {
    if (!knownInsightIds.has(reference)) throw new Error(`Insight reference does not exist: ${reference}`);
  }
  if (insight.kind === "contradiction" && !(insight.contradictionOf?.length)) throw new Error("Contradiction insights must reference an insight");
  if (insight.lifecycle === "superseded" && !(insight.supersedes?.length)) throw new Error("Superseded insights must identify what they supersede");
}

export function validateCollaborationRound(round: CollaborationRound, knownInsightIds: ReadonlySet<string> = new Set()): void {
  if (!hasText(round.id) || !hasText(round.workstreamId) || !hasText(round.topic) || !hasText(round.synthesizerAgentId)) throw new Error("Collaboration round identity and topic are required");
  if (round.participantAgentIds.length === 0 || new Set(round.participantAgentIds).size !== round.participantAgentIds.length) throw new Error("Collaboration round requires unique participants");
  if (!round.participantAgentIds.includes(round.synthesizerAgentId)) throw new Error("Synthesizer must be a participant");
  if (!Number.isInteger(round.maxTurns) || round.maxTurns < 1) throw new Error("Collaboration round maxTurns must be positive");
  if (!isIsoDate(round.deadline) || Date.parse(round.deadline) <= Date.now()) throw new Error("Collaboration round deadline must be in the future");
  if (!collaborationRoundStatuses.includes(round.status)) throw new Error(`Unsupported collaboration round status: ${round.status}`);
  if (!["all_participants", "synthesizer", "human_approval"].includes(round.completionRule)) throw new Error("Unsupported collaboration round completion rule");
  for (const insightId of round.insightIds) if (!knownInsightIds.has(insightId)) throw new Error(`Collaboration round insight does not exist: ${insightId}`);
}
