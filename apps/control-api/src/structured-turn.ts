import { createHash } from "node:crypto";
import {
  agentTurnResultSchema,
  type AgentTurnResult,
} from "@agentweave/protocol";
import { validateInsight, type Insight } from "@agentweave/domain";
import type {
  PersistedAgent,
  PersistedMessage,
  PersistedTask,
} from "./repositories/types.js";

export class InvalidStructuredTurn extends Error {}
export type TurnContext = {
  workstreamId: string;
  agentId: string;
  turnId: string;
  correlationId: string;
  taskId?: string;
  agents: PersistedAgent[];
  tasks: PersistedTask[];
  insights: Insight[];
  evidenceIds: string[];
  now: string;
};
export type StructuredTurnPlan = {
  id: string;
  fingerprint: string;
  workstreamId: string;
  agentId: string;
  sourceTaskId?: string;
  sourceEvidenceIds: string[];
  summary: string;
  tasks: PersistedTask[];
  insights: Insight[];
  messages: PersistedMessage[];
  waitingForHuman: boolean;
  blocked: boolean;
  createdAt: string;
};

export function parseStructuredTurn(value: unknown): AgentTurnResult {
  const parsed = agentTurnResultSchema.safeParse(value);
  if (!parsed.success)
    throw new InvalidStructuredTurn(
      `Invalid AgentTurnResult: ${parsed.error.message}`,
    );
  return parsed.data;
}

// Existing adapters may wrap legacy text in a summary-only result.
export function hasStructuredActions(result: AgentTurnResult): boolean {
  return Boolean(
    result.insights.length ||
    result.tasks.length ||
    result.messages.length ||
    result.decision ||
    result.completionProposal ||
    result.humanBlock,
  );
}

export function planStructuredTurn(
  result: AgentTurnResult,
  context: TurnContext,
): StructuredTurnPlan {
  const fail = (message: string): never => {
    throw new InvalidStructuredTurn(message);
  };
  if (!context.turnId.trim()) fail("Structured turn requires a stable turn ID");
  if (!context.agents.some((agent) => agent.id === context.agentId))
    fail("Unknown result author");
  const id = createHash("sha256")
    .update(
      JSON.stringify([context.workstreamId, context.agentId, context.turnId]),
    )
    .digest("hex");
  const scopedId = (kind: string, local: string) =>
    `${id}:${kind}:${encodeURIComponent(local)}`;
  const roleAgent = (role: string) => {
    const matches = context.agents.filter((agent) => agent.role === role);
    const aliases =
      role === "coder" && !matches.length
        ? context.agents.filter((agent) => agent.role === "backend")
        : matches;
    if (aliases.length !== 1) fail(`Unknown or ambiguous agent role: ${role}`);
    return aliases[0]!;
  };
  const unique = (ids: string[], kind: string) => {
    if (new Set(ids).size !== ids.length) fail(`Duplicate ${kind} ID`);
  };
  unique(
    result.tasks.map((task) => task.id),
    "task",
  );
  unique(
    result.insights.map((insight) => insight.id),
    "insight",
  );
  const sourceTask = context.tasks.find((task) => task.id === context.taskId);
  if (context.taskId && !sourceTask) fail("Unknown source task");
  if (sourceTask && sourceTask.ownerAgentId !== context.agentId)
    fail("Agent does not own the source task");
  const evidence = new Set(context.evidenceIds);
  const checkEvidence = (ids: string[]) => {
    for (const evidenceId of ids)
      if (!evidence.has(evidenceId)) fail(`Unverified evidence: ${evidenceId}`);
  };
  const tasks: PersistedTask[] = result.tasks.map((task) => ({
    id: scopedId("task", task.id),
    workstreamId: context.workstreamId,
    title: task.title,
    status: "assigned",
    ownerAgentId: roleAgent(task.ownerRole).id,
    createdByAgentId: context.agentId,
    ...(sourceTask ? { parentTaskId: sourceTask.id } : {}),
    relatedTaskIds: [],
    acceptanceCriteria: task.acceptanceCriteria,
    dependencies: [],
    evidence: [],
    createdAt: context.now,
    updatedAt: context.now,
  }));
  const localInsights = new Map(
    result.insights.map((item) => [item.id, scopedId("insight", item.id)]),
  );
  const known = new Set([
    ...context.insights.map((item) => item.id),
    ...localInsights.values(),
  ]);
  const reference = (ref: string) => localInsights.get(ref) ?? ref;
  const insights: Insight[] = result.insights.map((item) => {
    checkEvidence(item.evidenceIds);
    const insight: Insight = {
      ...item,
      id: localInsights.get(item.id)!,
      workstreamId: context.workstreamId,
      authorAgentId: context.agentId,
      lifecycle: "proposed",
      references: item.references.map(reference),
      contradictionOf: item.contradictionOf.map(reference),
      createdAt: context.now,
      updatedAt: context.now,
    };
    if (
      [...insight.references, ...(insight.contradictionOf ?? [])].includes(
        insight.id,
      )
    )
      fail("Insight cannot reference itself");
    try {
      validateInsight(insight, known);
    } catch (error) {
      fail(String(error));
    }
    return insight;
  });
  const messages: PersistedMessage[] = result.messages.map((item, index) => {
    const recipientId =
      item.recipientRole === "human"
        ? "human"
        : roleAgent(item.recipientRole).id;
    const task = item.taskId
      ? (tasks.find(
          (candidate) => candidate.id === scopedId("task", item.taskId!),
        ) ?? context.tasks.find((candidate) => candidate.id === item.taskId))
      : undefined;
    if (item.taskId && (!task || task.ownerAgentId !== recipientId))
      fail("Message task must exist and belong to its recipient");
    return {
      id: scopedId("message", String(index)),
      workstreamId: context.workstreamId,
      senderId: context.agentId,
      recipientIds: [recipientId],
      messageType: item.messageType,
      content: item.content,
      ...(task ? { taskId: task.id } : {}),
      correlationId: context.correlationId,
      causationId: id,
      evidenceIds: [],
      createdAt: context.now,
      deliveryStatus: "pending",
    };
  });
  const blocked = Boolean(
    result.humanBlock ||
    ["wait", "ask_human"].includes(result.decision?.action ?? ""),
  );
  const waitingForHuman =
    blocked ||
    Boolean(
      result.completionProposal || result.decision?.action === "complete",
    );
  if (
    waitingForHuman &&
    (tasks.length ||
      messages.some((message) => !message.recipientIds.includes("human")))
  )
    fail("Human-blocked or completion turns cannot dispatch new agent work");
  if (result.completionProposal)
    checkEvidence(result.completionProposal.evidenceIds);
  if (waitingForHuman) {
    const content = result.humanBlock
      ? `${result.humanBlock.question}\n${result.humanBlock.context}`
      : (result.completionProposal?.reason ?? result.decision!.reason);
    messages.push({
      id: scopedId("message", "human-decision"),
      workstreamId: context.workstreamId,
      senderId: context.agentId,
      recipientIds: ["human"],
      messageType: blocked ? "clarification" : "decision",
      content,
      correlationId: context.correlationId,
      causationId: id,
      evidenceIds: result.completionProposal?.evidenceIds ?? [],
      createdAt: context.now,
      deliveryStatus: "pending",
    });
  }
  return {
    id,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          result,
          context.taskId ?? null,
          [...context.evidenceIds].sort(),
        ]),
      )
      .digest("hex"),
    workstreamId: context.workstreamId,
    agentId: context.agentId,
    ...(sourceTask ? { sourceTaskId: sourceTask.id } : {}),
    sourceEvidenceIds: context.evidenceIds,
    summary: result.summary,
    tasks,
    insights,
    messages,
    waitingForHuman,
    blocked,
    createdAt: context.now,
  };
}
