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

export const agentStatuses = [
  "idle",
  "running",
  "paused",
  "stopped",
  "failed",
  "done",
] as const;

export type AgentStatus = (typeof agentStatuses)[number];

/** The observe-only agent state machine used by every control-plane writer. */
export const agentTransitions: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ["running", "paused", "failed", "done", "stopped"],
  running: ["idle", "paused", "failed", "stopped"],
  paused: ["idle", "stopped", "done"],
  failed: ["idle", "paused", "stopped"],
  done: [],
  stopped: [],
};

export function canAgentTransition(from: AgentStatus, to: AgentStatus): boolean {
  return agentTransitions[from].includes(to);
}

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
  goalPrompt?: string;
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
  {
    id: "debate",
    name: "双语辩论（中文）",
    description: "由主持人裁判协调正方与反方，按固定顺序完成一场中文结构化辩论。",
    goalPrompt: "辩题：{{topic}}\n\n辩论流程必须严格按以下顺序：开场 → 正方开篇 → 反方开篇 → 正方反驳 → 反方反驳 → 正方自由交锋 → 反方自由交锋 → 裁决。主持人必须把每一次发言作为任务派发给对应辩手，等待结构化结果后再进入下一步。",
    roles: [
      { id: "moderator", label: "主持人／裁判", authority: "lead", description: "协调流程、必须把每次发言作为任务派发给对应辩手，并在收到结果后才进入下一步。主持人绝不代写任何辩手论点，未派发或未收到结果前绝不声称发言已派发；消息中不得提及文件、文件写入或工具。辩手必须以结构化 JSON turn-result contract 返回，完整发言放在 messages[0].content，且每次发言不超过 500 字。裁决第一行必须完全是“裁决：正方获胜”或“裁决：反方获胜”，随后给出理由。", color: "#818cf8", icon: "⚖️" },
      { id: "pro", label: "正方", authority: "executor", description: "代表正方完成被派发的开篇、反驳和自由交锋发言。" , color: "#22d3ee", icon: "＋" },
      { id: "con", label: "反方", authority: "executor", description: "代表反方完成被派发的开篇、反驳和自由交锋发言。", color: "#f472b6", icon: "－" },
    ],
    taskLanes: standardTaskLanes,
    orchestration: { leadRole: "moderator", planningRole: "moderator", executionRoles: ["pro", "con"], reviewRole: "moderator" },
  },
  {
    id: "debate-en",
    name: "Structured debate (English)",
    description: "A moderator-judge coordinates the affirmative and negative sides through a fixed structured English debate.",
    goalPrompt: "Topic: {{topic}}\n\nThe debate MUST follow this exact flow: opening → pro opening → con opening → pro rebuttal → con rebuttal → pro free exchange → con free exchange → verdict. The moderator must dispatch every speech as a task to the correct debater and wait for the structured result before moving on.",
    roles: [
      { id: "moderator", label: "Moderator / Judge", authority: "lead", description: "Coordinates the flow, MUST dispatch every speech as a task to the correct debater, and wait for the result before moving on. The moderator MUST never write a debater's argument or claim a speech was dispatched before it was; moderator messages must never mention files, file writes, or tools. Debaters MUST return the structured JSON turn-result contract with the full speech in messages[0].content, within 500 words. The verdict's first line MUST be exactly \"Verdict: Affirmative wins\" or \"Verdict: Negative wins\", followed by reasons.", color: "#818cf8", icon: "⚖️" },
      { id: "pro", label: "Affirmative / Pro", authority: "executor", description: "Delivers the assigned opening, rebuttal, and free-exchange speeches for the affirmative side.", color: "#22d3ee", icon: "＋" },
      { id: "con", label: "Negative / Con", authority: "executor", description: "Delivers the assigned opening, rebuttal, and free-exchange speeches for the negative side.", color: "#f472b6", icon: "－" },
    ],
    taskLanes: standardTaskLanes,
    orchestration: { leadRole: "moderator", planningRole: "moderator", executionRoles: ["pro", "con"], reviewRole: "moderator" },
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
  const goalPrompt = typeof value.goalPrompt === "string" && value.goalPrompt.trim() ? value.goalPrompt : undefined;

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
      ...(goalPrompt ? { goalPrompt } : {}),
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
