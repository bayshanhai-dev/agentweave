import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("historical message dispositions migration", () => {
  it("marks the four audited historical patterns with explicit reasons", () => {
    const source = readFileSync(fileURLToPath(new URL("../../../db/migrations/014_message_dispositions.sql", import.meta.url)), "utf8");
    expect(source).toContain("terminal_status = 'dismissed'");
    expect(source).toContain("implementation-trigger");
    expect(source).toContain("[X-DATA RESULT]");
    expect(source).toContain("GLOBAL METRICS WATCH");
    expect(source).toContain("Format request #5");
  });
});
