import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcilePendingHumanMessagesOnBoot } from "../src/human-message-boot-recovery.js";
import { runMigrations } from "../src/migrations.js";
import { MessageRepository } from "../src/repositories/message-repository.js";
import { RuntimeRepository } from "../src/repositories/runtime-repository.js";
import { WorkstreamRepository } from "../src/repositories/workstream-repository.js";

const databaseUrl = process.env.HUMAN_MESSAGE_RECOVERY_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("boot-time Human message recovery from PostgreSQL", () => {
  const sql = postgres(databaseUrl ?? "postgres://unused", { max: 4 });
  const fixtureId = `human-recovery-${randomUUID()}`;
  const workstreamId = `${fixtureId}-workstream`;
  const leadId = `${fixtureId}-lead`;
  const taskId = `${fixtureId}-task`;
  const messageId = `${fixtureId}-message`;
  const messageRepository = new MessageRepository(sql);
  const runtimeRepository = new RuntimeRepository(sql);
  const workstreamRepository = new WorkstreamRepository(sql);

  beforeAll(async () => {
    await runMigrations(sql);
    await sql`insert into workstreams (id, goal, flavor, status, tool, model, workspace_root)
      values (${workstreamId}, 'Recover a stranded Human instruction', 'software-development', 'active', 'mock', 'deterministic', '/tmp')`;
    await sql`insert into agents (id, workstream_id, role, authority, status)
      values (${leadId}, ${workstreamId}, 'product-manager', 'lead', 'idle')`;
    await sql`insert into tasks (id, workstream_id, title, status, owner_agent_id)
      values (${taskId}, ${workstreamId}, 'Continue the owner-team work', 'assigned', ${leadId})`;
    await sql`insert into messages (id, workstream_id, sender_id, recipient_ids, message_type, content, task_id, correlation_id, created_at, delivery_status)
      values (${messageId}, ${workstreamId}, 'human', ${[leadId]}, 'directive', 'Continue the owner-team work', ${taskId}, ${`${fixtureId}-correlation`}, now(), 'delivered')`;
    await sql`insert into message_deliveries (message_id, recipient_id, delivery_status, delivered_at)
      values (${messageId}, ${leadId}, 'delivered', now())`;
  });

  afterAll(async () => {
    await sql`delete from task_execution_claims where workstream_id = ${workstreamId}`;
    await sql`delete from workstreams where id = ${workstreamId}`;
    await sql.end();
  });

  it("re-drives after a fresh load and skips once a durable turn claim exists", async () => {
    const rows = await messageRepository.listRows(workstreamId);
    const agentRows = await workstreamRepository.listAgentRows(workstreamId);
    const freshWorkstream = {
      id: workstreamId,
      status: "active",
      agents: agentRows.map((row) => ({ id: String(row.id) })),
      messages: rows.map((row) => ({
        id: String(row.id),
        senderId: String(row.sender_id),
        recipientIds: row.recipient_ids as string[],
        deliveryStatus: String(row.delivery_status),
        correlationId: String(row.correlation_id),
        ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      })),
    };
    const dispatch = vi.fn(async () => true);
    const dependencies = {
      hasExecutionClaim: (candidateMessageId: string, recipientId: string) =>
        runtimeRepository.hasMessageExecutionClaim(
          workstreamId,
          candidateMessageId,
          recipientId,
        ),
      dispatch,
      emit: vi.fn(),
    };

    const first = await reconcilePendingHumanMessagesOnBoot(
      freshWorkstream,
      dependencies,
    );
    await sql`insert into task_execution_claims (task_id, workstream_id, worker_id, message_id, status, lease_expires_at)
      values (${`${fixtureId}-execution`}, ${workstreamId}, 'worker-test', ${`${messageId}:${leadId}:boot-attempt`}, 'completed', now())`;
    const second = await reconcilePendingHumanMessagesOnBoot(
      freshWorkstream,
      dependencies,
    );

    expect(first).toMatchObject({
      redriven: 1,
      redrivenWithExistingTask: 1,
      skipped: 0,
    });
    expect(second).toMatchObject({
      redriven: 0,
      skipped: 1,
      skippedDispatchedTurn: 1,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ taskId }),
      [leadId],
    );
    expect(
      Number((await sql`select count(*) as count from tasks where id = ${taskId}`)[0]?.count),
    ).toBe(1);
  });
});
