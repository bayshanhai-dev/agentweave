import type { Sql } from "postgres";
import type { PersistedMessage } from "./types.js";

export class MessageRepository {
  constructor(private readonly sql: Sql) {}

  async findRow(workstreamId: string, messageId: string) {
    const rows = await this
      .sql`select id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status from messages where id = ${messageId} and workstream_id = ${workstreamId}`;
    return rows[0];
  }

  async listRows(workstreamId: string) {
    return this
      .sql`select id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status from messages where workstream_id = ${workstreamId} order by created_at asc`;
  }

  async listRowsAfter(after: string) {
    return this
      .sql`select m.* from messages m where m.created_at > ${after} order by m.created_at asc`;
  }

  async listInboxRows(workstreamId: string, agentId: string) {
    return this
      .sql`select m.*, d.delivery_status as recipient_delivery_status from messages m join message_deliveries d on d.message_id = m.id where m.workstream_id = ${workstreamId} and d.recipient_id = ${agentId} order by m.created_at asc`;
  }

  async create(message: PersistedMessage): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`insert into messages (id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, causation_id, evidence_ids, created_at, delivery_status)
        values (${message.id}, ${message.workstreamId}, ${message.senderId}, ${message.recipientIds}, ${message.messageType}, ${message.content}, ${message.taskId ?? null}, ${message.correlationId}, ${message.causationId ?? null}, ${JSON.stringify(message.evidenceIds)}, ${message.createdAt}, ${message.deliveryStatus})`;
      await transaction`insert into message_deliveries ${transaction(message.recipientIds.map((recipientId) => ({ message_id: message.id, recipient_id: recipientId, delivery_status: "pending" })))} on conflict do nothing`;
    });
  }

  async markDelivered(messageId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`update message_deliveries set delivery_status = 'delivered', delivered_at = now() where message_id = ${messageId}`;
      await transaction`update messages set delivery_status = 'delivered' where id = ${messageId}`;
    });
  }

  async updateDelivery(
    messageId: string,
    recipientId: string,
    status: "acknowledged" | "failed",
  ): Promise<"acknowledged" | "failed" | undefined> {
    return this.sql.begin(async (transaction) => {
      const updated =
        await transaction`update message_deliveries set delivery_status = ${status}, delivered_at = coalesce(delivered_at, now()) where message_id = ${messageId} and recipient_id = ${recipientId} returning message_id`;
      if (!updated.length) return undefined;
      const pending =
        status === "acknowledged"
          ? await transaction`select 1 from message_deliveries where message_id = ${messageId} and delivery_status <> 'acknowledged' limit 1`
          : [true];
      const aggregateStatus =
        status === "failed"
          ? "failed"
          : pending.length
            ? undefined
            : "acknowledged";
      if (aggregateStatus)
        await transaction`update messages set delivery_status = ${aggregateStatus} where id = ${messageId}`;
      return aggregateStatus;
    });
  }
}
