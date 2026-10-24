import type { WorkstreamTemplate } from "@agentweave/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { TemplateRepository } from "../src/template-repository.js";

const template: WorkstreamTemplate = {
  id: "podcast-production",
  name: "Podcast production",
  description: "Produce a podcast episode.",
  roles: [
    {
      id: "producer",
      label: "Producer",
      authority: "lead",
      description: "Coordinates production.",
    },
  ],
  taskLanes: [{ status: "ready", label: "Ready", color: "gray" }],
  orchestration: {
    leadRole: "producer",
    planningRole: "producer",
    executionRoles: ["producer"],
    reviewRole: "producer",
  },
};

function fakeSql(rows: Record<string, unknown>[] = []) {
  const calls: unknown[][] = [];
  const json = vi.fn((value: unknown) => ({ type: "jsonb", value }));
  const sql = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return rows;
    }),
    { json },
  ) as unknown as Sql;
  return { sql, calls, json };
}

describe("TemplateRepository", () => {
  it("binds custom templates with the driver's JSON support", async () => {
    const fake = fakeSql();

    await new TemplateRepository(fake.sql).saveCustom(template);

    expect(fake.json).toHaveBeenCalledWith(template);
    expect(fake.calls[0]?.[0]).toBe(template.id);
    expect(fake.calls[0]?.[1]).toMatchObject({
      type: "jsonb",
      value: { id: template.id },
    });
    expect(JSON.parse(JSON.stringify(fake.calls[0]?.[1]))).toMatchObject({
      value: { id: template.id },
    });
  });

  it("loads normal and legacy double-encoded template rows", async () => {
    const fake = fakeSql([
      { template },
      { template: JSON.stringify(JSON.stringify(template)) },
    ]);

    await expect(
      new TemplateRepository(fake.sql).listCustom(),
    ).resolves.toEqual([template, template]);
  });
});
