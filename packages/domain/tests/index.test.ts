import { describe, expect, it } from "vitest";
import { canTransition } from "../src/index.js";

describe("workstream transitions", () => {
  it("allows active workstreams to pause", () => {
    expect(canTransition("active", "pausing")).toBe(true);
  });

  it("does not allow archived workstreams to restart", () => {
    expect(canTransition("archived", "active")).toBe(false);
  });
});
