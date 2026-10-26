import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { WorkstreamRepository } from "../src/repositories/workstream-repository.js";

function fakeSql() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const transaction = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return [];
    },
  ) as unknown as Sql;
  const json = vi.fn((value: unknown) => ({ type: "jsonb", value }));
  const begin = vi.fn(async (callback: (sql: Sql) => Promise<unknown>) => callback(transaction));
  const sql = Object.assign(vi.fn(), { begin, json }) as unknown as Sql;
  return { sql, calls, json };
}

describe("WorkstreamRepository", () => {
  it("binds role providers as a JSON object when creating a workstream", async () => {
    const fake = fakeSql();
    const roleProviders = { editor: { tool: "codex" as const, model: "gpt-5.6-sol" } };

    await new WorkstreamRepository(fake.sql).create({
      id: "workstream-1",
      goal: "Ship the fix",
      flavor: "software-delivery",
      status: "active",
      provider: { tool: "ollama" },
      roleProviders,
      workspaceRoot: "/workspace",
      agents: [],
    });

    expect(fake.json).toHaveBeenCalledWith(roleProviders);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.text).toContain("role_providers");
    expect(fake.calls[0]?.values[6]).toMatchObject({
      type: "jsonb",
      value: roleProviders,
    });
  });
});
