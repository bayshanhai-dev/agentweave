import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { TriggerRepository } from "../src/repositories/trigger-repository.js";

function fakeSql(responses: Record<string, unknown>[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return responses.shift() ?? [];
    },
  ) as unknown as Sql;
  return { sql, calls };
}

describe("trigger persistence shape", () => {
  const migration = readFileSync(
    new URL("../../../db/migrations/009_triggers.sql", import.meta.url),
    "utf8",
  );
  const repository = readFileSync(
    new URL("../src/repositories/trigger-repository.ts", import.meta.url),
    "utf8",
  );

  it("defines trigger configuration and idempotent audit tables", () => {
    expect(migration).toContain("create table if not exists triggers");
    expect(migration).toContain("create table if not exists trigger_fires");
    expect(migration).toContain("unique (trigger_id, slot_key)");
    expect(migration).toContain("on delete cascade");
    expect(migration).toContain("goal_template is not null");
  });

  it("maps persisted trigger rows into the scheduler model", async () => {
    const fake = fakeSql([
      [
        {
          id: "trigger-1",
          name: "Daily review",
          enabled: true,
          kind: "schedule",
          cron_expr: "0 9 * * *",
          timezone: "Europe/Paris",
          target_mode: "workstream",
          target_workstream_id: "ws-1",
          template_id: null,
          goal_template: null,
          duty_title: "Review",
          duty_prompt: "Review {{date}}",
          state_key: "release-watch",
          priority: 4,
          max_runs_per_day: 2,
          quiet_start: "22:00",
          quiet_end: "07:00",
          batch_window_sec: 0,
          overlap_policy: "skip",
          last_fired_at: "2026-01-15T09:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-15T09:00:00.000Z",
        },
      ],
    ]);

    await expect(new TriggerRepository(fake.sql).list()).resolves.toEqual([
      {
        id: "trigger-1",
        name: "Daily review",
        enabled: true,
        kind: "schedule",
        cronExpr: "0 9 * * *",
        timezone: "Europe/Paris",
        targetMode: "workstream",
        targetWorkstreamId: "ws-1",
        dutyTitle: "Review",
        dutyPrompt: "Review {{date}}",
        stateKey: "release-watch",
        priority: 4,
        maxRunsPerDay: 2,
        quietStart: "22:00",
        quietEnd: "07:00",
        batchWindowSec: 0,
        overlapPolicy: "skip",
        lastFiredAt: "2026-01-15T09:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-15T09:00:00.000Z",
      },
    ]);
    expect(fake.calls[0]?.text).toContain("order by priority desc, name asc");
  });

  it("implements overlap lookups through linked tasks and created workstreams", () => {
    expect(repository).toContain("join messages m");
    expect(repository).toContain("join tasks t");
    expect(repository).toContain("join workstreams w");
    expect(repository).toContain("m.correlation_id like");
  });

  it("resolves a fired duty directly from its completed task", async () => {
    const fake = fakeSql([
      [
        {
          trigger_id: "trigger-1",
          workstream_id: "ws-1",
          state_key: "release-watch",
        },
      ],
    ]);
    await expect(
      new TriggerRepository(fake.sql).findDutyContextByTaskId("task-1"),
    ).resolves.toEqual({
      triggerId: "trigger-1",
      workstreamId: "ws-1",
      stateKey: "release-watch",
    });
    expect(fake.calls[0]?.text).toContain("f.duty_task_id = ?");
    expect(fake.calls[0]?.text).toContain("coalesce(t.state_key, t.name)");
    expect(fake.calls[0]?.values).toEqual(["task-1"]);
  });
});
