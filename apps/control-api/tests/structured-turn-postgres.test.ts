import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.js";
import {
  parseStructuredTurn,
  planStructuredTurn,
} from "../src/structured-turn.js";
import { StructuredTurnRepository } from "../src/repositories/structured-turn-repository.js";

const databaseUrl = process.env.STRUCTURED_TURN_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("structured turn PostgreSQL transactions", () => {
  const sql = postgres(databaseUrl ?? "postgres://unused", { max: 4 });
  const workstreamId = `structured-test-${randomUUID()}`;
  const repository = new StructuredTurnRepository(sql);
  const plan = (turnId: string) =>
    planStructuredTurn(
      parseStructuredTurn({
        summary: "A proposal addressed to its reviewer",
        insights: [{ id: "idea", content: "Separate the document model" }],
        tasks: [{ id: "review", title: "Review the model", ownerRole: "pe" }],
        messages: [
          { recipientRole: "pe", content: "Check the model", taskId: "review" },
        ],
      }),
      {
        workstreamId,
        agentId: `${workstreamId}:pm`,
        turnId,
        correlationId: turnId,
        agents: ["pm", "pe"].map((role) => ({
          id: `${workstreamId}:${role}`,
          role,
          authority: "lead",
          status: "idle",
        })),
        tasks: [],
        insights: [],
        evidenceIds: [],
        now: new Date().toISOString(),
      },
    );

  beforeAll(async () => {
    await runMigrations(sql);
    await sql`insert into workstreams (id, goal, flavor, status, tool, model, workspace_root) values (${workstreamId}, 'test', 'software-development', 'active', 'mock', 'deterministic', '')`;
    for (const role of ["pm", "pe"])
      await sql`insert into agents (id, workstream_id, role, authority, status) values (${`${workstreamId}:${role}`}, ${workstreamId}, ${role}, 'lead', 'idle')`;
  });
  afterAll(async () => {
    await sql`delete from workstreams where id = ${workstreamId}`;
    await sql.end();
  });

  it("persists a result once under concurrent retries and retains causal inbox routing", async () => {
    const proposed = plan("same-turn");
    await Promise.all([repository.apply(proposed), repository.apply(proposed)]);
    const tasks =
      await sql`select * from tasks where id = ${proposed.tasks[0].id}`;
    const insights =
      await sql`select * from insights where id = ${proposed.insights[0].id}`;
    const inbox =
      await sql`select m.*, d.recipient_id from messages m join message_deliveries d on d.message_id = m.id where m.id = ${proposed.messages[0].id}`;
    expect(tasks).toHaveLength(1);
    expect(insights).toHaveLength(1);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      sender_id: `${workstreamId}:pm`,
      recipient_id: `${workstreamId}:pe`,
      task_id: tasks[0].id,
      causation_id: proposed.id,
    });
    await expect(
      repository.apply({ ...proposed, fingerprint: "changed" }),
    ).rejects.toThrow(/different result/);
  });
  it("rolls back all effects and the receipt when a later insert fails", async () => {
    const proposed = plan("rollback");
    proposed.messages.push(proposed.messages[0]); // force a constraint error after tasks and insights were inserted
    await expect(repository.apply(proposed)).rejects.toThrow();
    expect(
      await sql`select id from tasks where id = ${proposed.tasks[0].id}`,
    ).toHaveLength(0);
    expect(
      await sql`select id from insights where id = ${proposed.insights[0].id}`,
    ).toHaveLength(0);
    expect(
      await sql`select id from structured_turns where id = ${proposed.id}`,
    ).toHaveLength(0);
  });
  it("commits source-task completion and Human review together, including retries", async () => {
    const initial = plan("source-task");
    await repository.apply(initial);
    const source = initial.tasks[0];
    const completion = planStructuredTurn(
      parseStructuredTurn({
        summary: "Ready for review",
        completionProposal: { reason: "Human should inspect the result" },
      }),
      {
        workstreamId,
        agentId: source.ownerAgentId!,
        turnId: "review-complete",
        correlationId: "review-complete",
        taskId: source.id,
        agents: [
          {
            id: source.ownerAgentId!,
            role: "pe",
            authority: "reviewer",
            status: "running",
          },
        ],
        tasks: [source],
        insights: [],
        evidenceIds: [],
        now: new Date().toISOString(),
      },
    );
    await repository.apply(completion);
    await repository.apply(completion);
    expect(
      (await sql`select status from tasks where id = ${source.id}`)[0].status,
    ).toBe("done");
    expect(
      (await sql`select status from workstreams where id = ${workstreamId}`)[0]
        .status,
    ).toBe("waiting_for_human");
    expect(
      (
        await sql`select status from agents where id = ${source.ownerAgentId!}`
      )[0].status,
    ).toBe("idle");
    expect(
      await sql`select id from messages where id = ${completion.messages[0].id}`,
    ).toHaveLength(1);
  });
});
