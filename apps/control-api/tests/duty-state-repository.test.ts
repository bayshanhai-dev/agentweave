import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { DutyStateRepository } from "../src/repositories/duty-state-repository.js";

function statefulSql() {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const updatedAt = "2026-01-15T14:00:00.000Z";
  const sql = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, values });
      const workstreamId = String(values[0]);
      const stateKey = String(values[1] ?? "");
      if (text.includes("insert into duty_state")) {
        const row = {
          state_key: stateKey,
          state: JSON.parse(String(values[2])),
          updated_at: updatedAt,
        };
        rows.set(`${workstreamId}:${stateKey}`, row);
        return [row];
      }
      if (text.includes("and state_key")) {
        const row = rows.get(`${workstreamId}:${stateKey}`);
        return row ? [row] : [];
      }
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(`${workstreamId}:`))
        .map(([, row]) => row);
    },
  ) as unknown as Sql;
  return { sql, calls };
}

describe("DutyStateRepository", () => {
  it("defines workstream-scoped state and trigger/task linkage", () => {
    const migration = readFileSync(
      new URL("../../../db/migrations/010_duty_state.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("create table if not exists duty_state");
    expect(migration).toContain("references workstreams(id) on delete cascade");
    expect(migration).toContain("primary key (workstream_id, state_key)");
    expect(migration).toContain("triggers add column if not exists state_key");
    expect(migration).toContain(
      "trigger_fires add column if not exists duty_task_id",
    );
  });

  it("round-trips and lists full-replacement JSON state", async () => {
    const fake = statefulSql();
    const repository = new DutyStateRepository(fake.sql);
    await expect(
      repository.get("ws-1", "release-watch"),
    ).resolves.toBeUndefined();
    await expect(
      repository.upsert("ws-1", "release-watch", {
        lastCheckedAt: "2026-01-15T13:59:00Z",
        issues: { api: "resolved" },
      }),
    ).resolves.toEqual({
      stateKey: "release-watch",
      state: {
        lastCheckedAt: "2026-01-15T13:59:00Z",
        issues: { api: "resolved" },
      },
      updatedAt: "2026-01-15T14:00:00.000Z",
    });
    await expect(
      repository.get("ws-1", "release-watch"),
    ).resolves.toMatchObject({
      stateKey: "release-watch",
      state: { issues: { api: "resolved" } },
    });
    await expect(repository.listByWorkstream("ws-1")).resolves.toHaveLength(1);
    expect(
      fake.calls.some((call) =>
        call.text.includes("on conflict (workstream_id, state_key) do update"),
      ),
    ).toBe(true);
  });
});
