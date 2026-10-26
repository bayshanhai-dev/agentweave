import type { Sql } from "postgres";
import type { PersistedMessage } from "./types.js";

export type DeliveryStatus =
  | "pending"
  | "delivered"
  | "gated"
  | "claimed"
  | "acknowledged"
  | "failed";

/**
 * Delivery lifecycle ranks. `gated` means the worker signed for the message
 * while its workstream was parked (paused / waiting for a human), so no agent
 * turn ran for it. `claimed` means the worker picked the message up and
 * started the recipient's turn. Terminal states (acknowledged / failed) are
 * sticky: a delivery never regresses out of them, and a live state never
 * regresses to an earlier rank either.
 */
const deliveryRank: Record<DeliveryStatus, number> = {
  pending: 0,
  delivered: 1,
  gated: 2,
  claimed: 3,
  acknowledged: 4,
  failed: 4,
};

const terminalDeliveryStatuses: ReadonlySet<string> = new Set([
  "acknowledged",
  "failed",
]);

export function nextDeliveryStatus(
  current: string,
  next: DeliveryStatus,
): DeliveryStatus {
  if (terminalDeliveryStatuses.has(current)) return current as DeliveryStatus;
  if (!(current in deliveryRank)) return next;
  return deliveryRank[next] > deliveryRank[current as DeliveryStatus]
    ? next
    : (current as DeliveryStatus);
}

export function aggregateDeliveryStatus(
  statuses: readonly string[],
): DeliveryStatus {
  if (!statuses.length) return "pending";
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((status) => status === "acknowledged"))
    return "acknowledged";
  if (statuses.includes("claimed")) return "claimed";
  if (statuses.includes("gated")) return "gated";
  if (statuses.includes("delivered")) return "delivered";
  return "pending";
}

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
    status: DeliveryStatus,
  ): Promise<DeliveryStatus | undefined> {
    return this.sql.begin(async (transaction) => {
      const current =
        await transaction`select delivery_status from message_deliveries where message_id = ${messageId} and recipient_id = ${recipientId}`;
      const currentRow = current[0];
      if (!currentRow) return undefined;
      const applied = nextDeliveryStatus(
        String(currentRow.delivery_status),
        status,
      );
      if (applied !== currentRow.delivery_status)
        await transaction`update message_deliveries set delivery_status = ${applied}, delivered_at = coalesce(delivered_at, now()) where message_id = ${messageId} and recipient_id = ${recipientId}`;
      const rows =
        await transaction`select delivery_status from message_deliveries where message_id = ${messageId}`;
      const aggregate = aggregateDeliveryStatus(
        rows.map((row) => String(row.delivery_status)),
      );
      const message =
        await transaction`select delivery_status from messages where id = ${messageId}`;
      const messageRow = message[0];
      if (!messageRow) return undefined;
      if (messageRow.delivery_status === aggregate) {
        // Preserve the historical contract for terminal reports: a failed
        // report always surfaces "failed" even when the aggregate already
        // said so (another recipient failed first).
        return status === "failed" ? "failed" : undefined;
      }
      await transaction`update messages set delivery_status = ${aggregate} where id = ${messageId}`;
      return aggregate;
    });
  }
}
