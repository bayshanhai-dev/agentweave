import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Control API persistence boundary", () => {
  it("keeps SQL out of the transport entrypoint", () => {
    const source = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/sql`/);
    expect(source).not.toMatch(/\bsql\(/);
  });

  it("defines repositories for every durable control-plane entity", () => {
    for (const file of [
      "workstream-repository.ts",
      "task-repository.ts",
      "message-repository.ts",
      "workflow-event-repository.ts",
      "workstream-command-repository.ts",
      "runtime-repository.ts",
      "evidence-repository.ts",
    ]) {
      expect(
        readFileSync(
          new URL(`../src/repositories/${file}`, import.meta.url),
          "utf8",
        ),
      ).toContain("Repository");
    }
  });
});
