import { describe, expect, it } from "vitest";
import { canTransition, getWorkstreamTemplate, workstreamTemplates } from "../src/index.js";

describe("workstream transitions", () => {
  it("allows active workstreams to pause", () => {
    expect(canTransition("active", "pausing")).toBe(true);
  });

  it("does not allow archived workstreams to restart", () => {
    expect(canTransition("archived", "active")).toBe(false);
  });
});

describe("workstream templates", () => {
  it("publishes the software-development template as data with unique roles and lanes", () => {
    const template = getWorkstreamTemplate("software-development");
    expect(template).toBeDefined();
    expect(template?.orchestration.leadRole).toBe("pm");
    expect(new Set(template?.roles.map((role) => role.id)).size).toBe(template?.roles.length);
    expect(new Set(template?.taskLanes.map((lane) => lane.status)).size).toBe(template?.taskLanes.length);
  });

  it("does not return a template for an unknown id", () => {
    expect(getWorkstreamTemplate("research")).toBeUndefined();
    expect(workstreamTemplates).toHaveLength(1);
  });
});
