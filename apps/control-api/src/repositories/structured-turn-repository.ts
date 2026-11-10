import type { Sql } from "postgres";
import type { AgentStatus } from "@agentweave/domain";
import {
  InvalidStructuredTurn,
  type StructuredTurnPlan,
} from "../structured-turn.js";
import { transitionAgentStatus, type AgentStatusEvent } from "../agent-status.js";
import { TaskRepository } from "./task-repository.js";
import { InsightRepository } from "./insight-repository.js";

/** Persist validated effects and a retry receipt before publishing messages. */
export class StructuredTurnRepository {
  constructor(
    private readonly sql: Sql,
    private readonly onAgentStatusEvent?: (event: AgentStatusEvent, workstreamId: string) => Promise<void> | void,
  ) {}

  async apply(plan: StructuredTurnPlan): Promise<StructuredTurnPlan> {
    const statusEvents: AgentStatusEvent[] = [];
    const result = await this.sql.begin(async (tx) => {
      const rows =
        await tx`select status from workstreams where id = ${plan.workstreamId} for update`;
      const previous =
        await tx`select fingerprint, plan from structured_turns where id = ${plan.id}`;
      if (previous[0]) {
        if (previous[0].fingerprint !== plan.fingerprint)
          throw new InvalidStructuredTurn(
            "Turn ID reused with a different result",
          );
        return (typeof previous[0].plan === "string"
          ? JSON.parse(previous[0].plan)
          : previous[0].plan) as StructuredTurnPlan;
      }
      if (!rows[0] || !["active", "starting"].includes(String(rows[0].status)))
        throw new InvalidStructuredTurn(
          "Workstream is not accepting agent results",
        );
      if (plan.sourceTaskId) {
        const tasks =
          await tx`select owner_agent_id, status from tasks where id = ${plan.sourceTaskId} and workstream_id = ${plan.workstreamId} for update`;
        if (
          !tasks[0] ||
          tasks[0].owner_agent_id !== plan.agentId ||
          ["done", "failed", "cancelled"].includes(String(tasks[0].status))
        )
          throw new InvalidStructuredTurn(
            "Source task is not owned and runnable",
          );
      }
      // These repository methods issue individual statements on the same transaction.
      const tasks = new TaskRepository(tx as unknown as Sql);
      const insights = new InsightRepository(tx as unknown as Sql);
      for (const task of plan.tasks) await tasks.save(task);
      for (const insight of plan.insights) await insights.saveInsight(insight);
      for (const message of plan.messages) {
        await tx`insert into messages (id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status)
          values (${message.id}, ${message.workstreamId}, ${message.senderId}, ${message.recipientIds}, ${message.messageType}, ${message.content}, ${message.taskId ?? null}, ${message.correlationId}, ${message.causationId ?? null}, ${JSON.stringify(message.evidenceIds)}, ${message.createdAt}, 'pending')
          on conflict (id) do nothing`;
        for (const recipient of message.recipientIds)
          await tx`insert into message_deliveries (message_id, recipient_id, delivery_status) values (${message.id}, ${recipient}, 'pending') on conflict do nothing`;
      }
      if (plan.sourceTaskId)
        await tx`update tasks set status = ${plan.blocked ? "blocked" : "done"}, evidence = ${JSON.stringify(plan.sourceEvidenceIds)}, updated_at = ${plan.createdAt} where id = ${plan.sourceTaskId}`;
      const agentRows = await tx`select id, status from agents where id = ${plan.agentId} and workstream_id = ${plan.workstreamId} for update`;
      if (agentRows[0]) {
        const agent = { id: String(agentRows[0].id), status: String(agentRows[0].status) as AgentStatus };
        await transitionAgentStatus(agent, "idle", {
          reason: "structured_turn_applied",
          ...(plan.sourceTaskId ? { taskId: plan.sourceTaskId } : {}),
          turnId: plan.id,
          actor: "structured-turn-repository",
        }, {
          persist: async (agentId, status) => {
            await tx`update agents set status = ${status} where id = ${agentId} and workstream_id = ${plan.workstreamId}`;
          },
          emit: (event) => { statusEvents.push(event); },
        });
      }
      if (plan.waitingForHuman)
        await tx`update workstreams set status = 'waiting_for_human', updated_at = ${plan.createdAt} where id = ${plan.workstreamId}`;
      await tx`insert into structured_turns (id, workstream_id, fingerprint, plan) values (${plan.id}, ${plan.workstreamId}, ${plan.fingerprint}, ${JSON.stringify(plan)})`;
      return plan;
    });
    for (const event of statusEvents)
      await this.onAgentStatusEvent?.(event, plan.workstreamId);
    return result;
  }
}
