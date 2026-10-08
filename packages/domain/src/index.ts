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
  /** Optional hex color (e.g. "#818cf8") used for the role's avatar and accents. */
  color?: string;
  /** Optional short icon (e.g. an emoji like "🎙️") shown as an avatar accessory. */
  icon?: string;
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
      { id: "pm", label: "PM", authority: "lead", description: "Coordinates work and completion review.", color: "#818cf8", icon: "🎯" },
      { id: "pe", label: "PE", authority: "lead", description: "Refines technical plans and acceptance criteria.", color: "#22d3ee", icon: "🧭" },
      { id: "backend", label: "Backend", authority: "executor", description: "Implements backend changes.", color: "#a78bfa", icon: "⚙️" },
      { id: "frontend", label: "Frontend", authority: "executor", description: "Implements user-facing changes.", color: "#f472b6", icon: "🎨" },
      { id: "qa", label: "QA", authority: "reviewer", description: "Verifies implementation and evidence.", color: "#34d399", icon: "🧪" },
      { id: "devops", label: "DevOps", authority: "executor", description: "Supports delivery and runtime operations.", color: "#fbbf24", icon: "🚀" },
    ],
    taskLanes: standardTaskLanes,
    orchestration: { leadRole: "pm", planningRole: "pe", executionRoles: ["backend", "frontend"], reviewRole: "qa" },
  },
  {
    id: "research-synthesis",
    name: "Research synthesis",
    description: "Frame a question, gather evidence, synthesize findings, and review the conclusion.",
    roles: [
      { id: "research-lead", label: "Research lead", authority: "lead", description: "Frames the question and coordinates the investigation.", color: "#818cf8", icon: "🔬" },
      { id: "researcher", label: "Researcher", authority: "executor", description: "Collects and evaluates source material.", color: "#22d3ee", icon: "📚" },
      { id: "synthesizer", label: "Synthesizer", authority: "executor", description: "Connects evidence into a coherent answer.", color: "#f472b6", icon: "🧩" },
      { id: "research-reviewer", label: "Research reviewer", authority: "reviewer", description: "Checks claims, evidence, and uncertainty.", color: "#34d399", icon: "🔍" },
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
  {
    id: "short-video-creator",
    name: "Short video creator",
    description: "Research an audience opportunity, produce a short-form video package, and review it before publishing.",
    roles: [
      { id: "creator-lead", label: "Creator lead", authority: "lead", description: "Owns the channel angle, brief, and publish decision.", color: "#818cf8", icon: "🎬" },
      { id: "trend-researcher", label: "Trend researcher", authority: "executor", description: "Finds audience opportunities, relevant references, and factual support.", color: "#22d3ee", icon: "📈" },
      { id: "video-producer", label: "Video producer", authority: "executor", description: "Produces the hook, script, storyboard, shot list, and post package.", color: "#f472b6", icon: "🎥" },
      { id: "audience-reviewer", label: "Audience reviewer", authority: "reviewer", description: "Checks clarity, platform fit, claims, and the strength of the opening hook.", color: "#34d399", icon: "👀" },
    ],
    taskLanes: [
      { status: "ready", label: "Brief", color: "gray" },
      { status: "assigned", label: "Research", color: "blue" },
      { status: "running", label: "Production", color: "yellow" },
      { status: "review", label: "Review", color: "violet" },
      { status: "done", label: "Ready to publish", color: "green" },
    ],
    orchestration: { leadRole: "creator-lead", planningRole: "trend-researcher", executionRoles: ["video-producer"], reviewRole: "audience-reviewer" },
  },
];

export function getWorkstreamTemplate(templateId: string, customTemplates: readonly WorkstreamTemplate[] = []): WorkstreamTemplate | undefined {
  return workstreamTemplates.find((template) => template.id === templateId) ?? customTemplates.find((template) => template.id === templateId);
}

export type TemplateValidationResult =
  | { ok: true; template: WorkstreamTemplate }
  | { ok: false; errors: string[] };

const templateSlugPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const templateHexColorPattern = /^#[0-9a-fA-F]{6}$/;
const templateAuthorities: readonly WorkstreamTemplateRole["authority"][] = ["lead", "executor", "reviewer"];
const templateLaneStatuses: readonly WorkstreamTaskLane["status"][] = [
  "ready",
  "assigned",
  "running",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

/**
 * Validates a user-supplied workstream template. Built-in templates are trusted
 * (they are code); anything arriving over the API must pass through here.
 */
export function validateWorkstreamTemplate(input: unknown): TemplateValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["template must be an object"] };
  }
  const value = input as Record<string, unknown>;

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) errors.push("id is required");
  else if (!templateSlugPattern.test(id)) errors.push("id must be a slug: lowercase letters, digits, '-' or '_'");

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) errors.push("name is required");
  const description = typeof value.description === "string" ? value.description : "";

  const roles: WorkstreamTemplateRole[] = [];
  if (!Array.isArray(value.roles) || value.roles.length < 2) {
    errors.push("roles must be an array with at least 2 entries");
  } else {
    const seen = new Set<string>();
    value.roles.forEach((entry, index) => {
      const path = `roles[${index}]`;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${path} must be an object`);
        return;
      }
      const role = entry as Record<string, unknown>;
      const roleId = typeof role.id === "string" ? role.id.trim() : "";
      if (!roleId) errors.push(`${path}.id is required`);
      else if (!templateSlugPattern.test(roleId)) errors.push(`${path}.id must be a slug: lowercase letters, digits, '-' or '_'`);
      else if (seen.has(roleId)) errors.push(`${path}.id "${roleId}" is duplicated`);
      else seen.add(roleId);
      const label = typeof role.label === "string" ? role.label.trim() : "";
      if (!label) errors.push(`${path}.label is required`);
      const authority = role.authority;
      if (!templateAuthorities.includes(authority as WorkstreamTemplateRole["authority"])) {
        errors.push(`${path}.authority must be one of: lead, executor, reviewer`);
      }
      let color: string | undefined;
      if (role.color !== undefined) {
        if (typeof role.color !== "string" || !templateHexColorPattern.test(role.color.trim())) {
          errors.push(`${path}.color must be a hex color like #818cf8`);
        } else {
          color = role.color.trim().toLowerCase();
        }
      }
      let icon: string | undefined;
      if (role.icon !== undefined) {
        if (typeof role.icon !== "string" || !role.icon.trim() || [...role.icon.trim()].length > 8) {
          errors.push(`${path}.icon must be a non-empty short string (e.g. an emoji)`);
        } else {
          icon = role.icon.trim();
        }
      }
      roles.push({
        id: roleId,
        label,
        authority: templateAuthorities.includes(authority as WorkstreamTemplateRole["authority"])
          ? (authority as WorkstreamTemplateRole["authority"])
          : "executor",
        description: typeof role.description === "string" ? role.description : "",
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
      });
    });
  }
  const roleIds = new Set(roles.map((role) => role.id));

  const orchestrationInput =
    typeof value.orchestration === "object" && value.orchestration !== null
      ? (value.orchestration as Record<string, unknown>)
      : {};
  const refField = (field: string): string => {
    const ref = typeof orchestrationInput[field] === "string" ? (orchestrationInput[field] as string).trim() : "";
    if (!ref) errors.push(`orchestration.${field} is required`);
    else if (!roleIds.has(ref)) errors.push(`orchestration.${field} "${ref}" does not match any role id`);
    return ref;
  };
  const leadRole = refField("leadRole");
  const planningRole = refField("planningRole");
  const reviewRole = refField("reviewRole");
  let executionRoles: string[] = [];
  if (!Array.isArray(orchestrationInput.executionRoles) || orchestrationInput.executionRoles.length === 0) {
    errors.push("orchestration.executionRoles must be a non-empty array");
  } else {
    executionRoles = (orchestrationInput.executionRoles as unknown[]).map((entry) => String(entry).trim());
    executionRoles.forEach((ref) => {
      if (!roleIds.has(ref)) errors.push(`orchestration.executionRoles "${ref}" does not match any role id`);
    });
  }

  const taskLanes: WorkstreamTaskLane[] = [];
  if (!Array.isArray(value.taskLanes) || value.taskLanes.length === 0) {
    errors.push("taskLanes must be a non-empty array");
  } else {
    value.taskLanes.forEach((entry, index) => {
      const path = `taskLanes[${index}]`;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${path} must be an object`);
        return;
      }
      const lane = entry as Record<string, unknown>;
      const status = lane.status;
      if (!templateLaneStatuses.includes(status as WorkstreamTaskLane["status"])) {
        errors.push(`${path}.status must be one of: ${templateLaneStatuses.join(", ")}`);
      }
      const label = typeof lane.label === "string" ? lane.label.trim() : "";
      if (!label) errors.push(`${path}.label is required`);
      const color = typeof lane.color === "string" ? lane.color.trim() : "";
      if (!color) errors.push(`${path}.color is required`);
      taskLanes.push({
        status: templateLaneStatuses.includes(status as WorkstreamTaskLane["status"])
          ? (status as WorkstreamTaskLane["status"])
          : "ready",
        label,
        color,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    template: {
      id,
      name,
      description,
      roles,
      taskLanes,
      orchestration: { leadRole, planningRole, executionRoles, reviewRole },
    },
  };
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
