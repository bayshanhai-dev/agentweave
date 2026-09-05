import type { Sql } from "postgres";
import {
  InvalidStructuredTurn,
  type StructuredTurnPlan,
} from "../structured-turn.js";
import { TaskRepository } from "./task-repository.js";
import { InsightRepository } from "./insight-repository.js";

/** Persist validated effects and a retry receipt before publishing messages. */
export class StructuredTurnRepository {
  constructor(private readonly sql: Sql) {}

  async apply(plan: StructuredTurnPlan): Promise<StructuredTurnPlan> {
    return this.sql.begin(async (tx) => {
      const rows =
        await tx`select status from workstreams where id = ${plan.workstreamId} for update`;
      const previous =
        await tx`select fingerprint, plan from structured_turns where id = ${plan.id}`;
      if (previous[0]) {
        if (previous[0].fingerprint !== plan.fingerprint)
          throw new InvalidStructuredTurn(
            "Turn ID reused with a different result",
          );
        return previous[0].plan as StructuredTurnPlan;
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
          values (${message.id}, ${message.workstreamId}, ${message.senderId}, ${message.recipientIds}, ${message.messageType}, ${message.content}, ${message.taskId ?? null}, ${message.correlationId}, ${message.causationId ?? null}, ${JSON.stringify(message.evidenceIds)}, ${message.createdAt}, 'pending')`;
        for (const recipient of message.recipientIds)
          await tx`insert into message_deliveries (message_id, recipient_id, delivery_status) values (${message.id}, ${recipient}, 'pending')`;
      }
      if (plan.sourceTaskId)
        await tx`update tasks set status = ${plan.blocked ? "blocked" : "done"}, evidence = ${JSON.stringify(plan.sourceEvidenceIds)}, updated_at = ${plan.createdAt} where id = ${plan.sourceTaskId}`;
      await tx`update agents set status = 'idle' where id = ${plan.agentId} and workstream_id = ${plan.workstreamId}`;
      if (plan.waitingForHuman)
        await tx`update workstreams set status = 'waiting_for_human', updated_at = ${plan.createdAt} where id = ${plan.workstreamId}`;
      await tx`insert into structured_turns (id, workstream_id, fingerprint, plan) values (${plan.id}, ${plan.workstreamId}, ${plan.fingerprint}, ${JSON.stringify(plan)})`;
      return plan;
    });
  }
}
