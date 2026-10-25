import { randomUUID } from "node:crypto";
import {
  resolveTaskDependencyPlan,
  type OrchestrationPolicy,
  type TaskSpec,
} from "./orchestrator.js";

type TaskOwnerAgent = { id: string; role: string };

export type OwnedTask = {
  id: string;
  workstreamId: string;
  title: string;
  status: "ready" | "assigned";
  ownerAgentId?: string;
  createdByAgentId?: string;
  parentTaskId?: string;
  relatedTaskIds: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  evidence: string[];
  qualityAttempts: number;
  createdAt: string;
  updatedAt: string;
};

type TaskCreationWorkstream = {
  id: string;
  agents: TaskOwnerAgent[];
  tasks: OwnedTask[];
};

type TaskCreationDependencies = {
  persistTask: (task: OwnedTask) => Promise<void>;
  emit: (type: string, message: string, role?: string) => void;
  now?: () => Date;
  createId?: () => string;
};

export function taskOwnerDefaultedMessage(
  title: string,
  requestedRole: string | undefined,
  leadRole: string,
): string {
  return `Task "${title}" defaulted to lead role ${leadRole} (requested role: ${requestedRole?.trim() || "unspecified"})`;
}

/** Creates durable tasks while preserving the invariant that a lead-owned fallback is used whenever possible. */
export async function createTasksWithOwnerFallback(
  workstream: TaskCreationWorkstream,
  specs: TaskSpec[],
  policy: Pick<OrchestrationPolicy, "leadRole">,
  dependencies: TaskCreationDependencies,
  creatorAgentId?: string,
): Promise<OwnedTask[]> {
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const createId = dependencies.createId ?? randomUUID;
  const taskIds = specs.map(() => `${workstream.id}:task-${createId()}`);
  const dependencyPlan = resolveTaskDependencyPlan(specs, taskIds);
  const lead = workstream.agents.find(
    (agent) => agent.role === policy.leadRole,
  );
  const creatorRole = creatorAgentId
    ? workstream.agents.find((agent) => agent.id === creatorAgentId)?.role
    : undefined;
  const defaulted: Array<{ task: OwnedTask; requestedRole?: string }> = [];

  const created = specs.map((spec, index): OwnedTask => {
    const requestedOwner = spec.ownerRole
      ? workstream.agents.find((agent) => agent.role === spec.ownerRole)
      : undefined;
    const owner = requestedOwner ?? lead;
    const task: OwnedTask = {
      id: taskIds[index]!,
      workstreamId: workstream.id,
      title: spec.title.trim(),
      status: owner ? "assigned" : "ready",
      ...(owner ? { ownerAgentId: owner.id } : {}),
      ...(creatorAgentId ? { createdByAgentId: creatorAgentId } : {}),
      ...(spec.parentTaskId ? { parentTaskId: spec.parentTaskId } : {}),
      relatedTaskIds: spec.relatedTaskIds ?? [],
      acceptanceCriteria: spec.acceptanceCriteria?.length
        ? spec.acceptanceCriteria
        : ["Task is completed with evidence"],
      dependencies: dependencyPlan.dependencies[index]!,
      evidence: [],
      qualityAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (!requestedOwner && lead)
      defaulted.push({
        task,
        ...(spec.ownerRole ? { requestedRole: spec.ownerRole } : {}),
      });
    return task;
  });

  workstream.tasks.push(...created);
  if (dependencyPlan.repairs.length) {
    dependencies.emit(
      "orchestration.decomposition_dependencies_repaired",
      `Decomposition dependency references repaired: ${dependencyPlan.repairs.join("; ").slice(0, 600)}`,
      creatorRole,
    );
  }
  for (const task of created) {
    await dependencies.persistTask(task);
    const fallback = defaulted.find((candidate) => candidate.task === task);
    if (fallback && lead) {
      dependencies.emit(
        "orchestration.task_owner_defaulted",
        taskOwnerDefaultedMessage(
          task.title,
          fallback.requestedRole,
          lead.role,
        ),
        creatorRole,
      );
    }
    dependencies.emit(
      "task.created",
      `${task.ownerAgentId ? "Task assigned" : "Task queued"}: ${task.title}`,
      creatorRole,
    );
  }
  return created;
}
