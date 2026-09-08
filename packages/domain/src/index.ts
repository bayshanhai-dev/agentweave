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

/**
 * A template describes the agents and task views for one kind of workstream.
 * The runtime treats role ids as data; only a template's orchestration policy
 * may assign a role a special responsibility.
 */
export type WorkstreamTemplateRole = {
  id: string;
  label: string;
  authority: "lead" | "reviewer" | "executor";
  description: string;
};

export type WorkstreamTaskLane = {
  status: "ready" | "assigned" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled";
  label: string;
  color: string;
};

export type WorkstreamTemplate = {
  id: string;
  name: string;
  description: string;
  roles: readonly WorkstreamTemplateRole[];
  taskLanes: readonly WorkstreamTaskLane[];
  orchestration: {
    leadRole: string;
    planningRole: string;
    executionRoles: readonly string[];
    reviewRole: string;
  };
};

const standardTaskLanes: readonly WorkstreamTaskLane[] = [
  { status: "ready", label: "Backlog", color: "gray" },
  { status: "assigned", label: "To Do", color: "blue" },
  { status: "running", label: "In Progress", color: "yellow" },
  { status: "review", label: "Review", color: "violet" },
  { status: "done", label: "Done", color: "green" },
];

export const workstreamTemplates: readonly WorkstreamTemplate[] = [
  {
    id: "software-development",
    name: "Software development",
    description: "Plan, implement, verify, and review a software change.",
    roles: [
      { id: "pm", label: "PM", authority: "lead", description: "Coordinates work and completion review." },
      { id: "pe", label: "PE", authority: "lead", description: "Refines technical plans and acceptance criteria." },
      { id: "backend", label: "Backend", authority: "executor", description: "Implements backend changes." },
      { id: "frontend", label: "Frontend", authority: "executor", description: "Implements user-facing changes." },
      { id: "qa", label: "QA", authority: "reviewer", description: "Verifies implementation and evidence." },
      { id: "devops", label: "DevOps", authority: "executor", description: "Supports delivery and runtime operations." },
    ],
    taskLanes: standardTaskLanes,
    orchestration: { leadRole: "pm", planningRole: "pe", executionRoles: ["backend", "frontend"], reviewRole: "qa" },
  },
  {
    id: "research-synthesis",
    name: "Research synthesis",
    description: "Frame a question, gather evidence, synthesize findings, and review the conclusion.",
    roles: [
      { id: "research-lead", label: "Research lead", authority: "lead", description: "Frames the question and coordinates the investigation." },
      { id: "researcher", label: "Researcher", authority: "executor", description: "Collects and evaluates source material." },
      { id: "synthesizer", label: "Synthesizer", authority: "executor", description: "Connects evidence into a coherent answer." },
      { id: "research-reviewer", label: "Research reviewer", authority: "reviewer", description: "Checks claims, evidence, and uncertainty." },
    ],
    taskLanes: [
      { status: "ready", label: "Question", color: "gray" },
      { status: "assigned", label: "Evidence", color: "blue" },
      { status: "running", label: "Synthesis", color: "yellow" },
      { status: "review", label: "Review", color: "violet" },
      { status: "done", label: "Published", color: "green" },
    ],
    orchestration: { leadRole: "research-lead", planningRole: "researcher", executionRoles: ["synthesizer"], reviewRole: "research-reviewer" },
  },
];

export function getWorkstreamTemplate(templateId: string): WorkstreamTemplate | undefined {
  return workstreamTemplates.find((template) => template.id === templateId);
}

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
