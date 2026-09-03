import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Insight persistence projection", () => {
  const migration = readFileSync(new URL("../../../db/migrations/004_insight_projections.sql", import.meta.url), "utf8");
  const repository = readFileSync(new URL("../src/repositories/insight-repository.ts", import.meta.url), "utf8");

  it("creates durable insight and collaboration-round storage with query indexes", () => {
    expect(migration).toContain("create table if not exists insights");
    expect(migration).toContain("create table if not exists collaboration_rounds");
    expect(migration).toContain("insights_references_idx");
    expect(migration).toContain("insights_contradictions_idx");
  });

  it("exposes durable read projections for synthesis and contradictions", () => {
    expect(repository).toContain("activeSynthesisInputs");
    expect(repository).toContain("opposingInsights");
    expect(repository).toContain("saveInsight");
    expect(repository).toContain("saveRound");
  });
});
