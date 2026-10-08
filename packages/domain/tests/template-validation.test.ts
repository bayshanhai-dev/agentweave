import { describe, expect, it } from "vitest";
import { validateWorkstreamTemplate, getWorkstreamTemplate, type WorkstreamTemplate } from "../src/index.js";

const validTemplate = {
  id: "podcast-production",
  name: "Podcast production",
  description: "Produce a podcast episode with a small crew.",
  roles: [
    { id: "producer", label: "Producer", authority: "lead", description: "Owns the episode plan." },
    { id: "host", label: "Host", authority: "executor", description: "Records the episode." },
    { id: "editor", label: "Editor", authority: "reviewer", description: "Reviews the cut." },
    { id: "showrunner", label: "Showrunner", authority: "executor", description: "Ships the episode." },
  ],
  taskLanes: [
    { status: "ready", label: "Backlog", color: "gray" },
    { status: "assigned", label: "To Do", color: "blue" },
    { status: "running", label: "In Progress", color: "yellow" },
    { status: "review", label: "Review", color: "violet" },
    { status: "done", label: "Done", color: "green" },
  ],
  orchestration: {
    leadRole: "producer",
    planningRole: "host",
    executionRoles: ["showrunner"],
    reviewRole: "editor",
  },
};

describe("validateWorkstreamTemplate", () => {
  it("accepts a well-formed custom template", () => {
    const result = validateWorkstreamTemplate(validTemplate);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template.id).toBe("podcast-production");
      expect(result.template.roles).toHaveLength(4);
    }
  });

  it("rejects missing name and fewer than 2 roles", () => {
    const result = validateWorkstreamTemplate({ id: "x", roles: [{ id: "a", label: "A", authority: "lead" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("name is required");
      expect(result.errors).toContain("roles must be an array with at least 2 entries");
    }
  });

  it("rejects bad slugs, duplicate role ids, and bad authorities", () => {
    const result = validateWorkstreamTemplate({
      ...validTemplate,
      id: "Bad ID!",
      roles: [
        { id: "producer", label: "Producer", authority: "lead" },
        { id: "producer", label: "Producer 2", authority: "boss" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("id must be a slug"))).toBe(true);
      expect(result.errors.some((e) => e.includes("is duplicated"))).toBe(true);
      expect(result.errors.some((e) => e.includes("authority must be one of"))).toBe(true);
    }
  });

  it("rejects orchestration references to unknown roles", () => {
    const result = validateWorkstreamTemplate({
      ...validTemplate,
      orchestration: { leadRole: "ghost", planningRole: "host", executionRoles: [], reviewRole: "editor" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('orchestration.leadRole "ghost"'))).toBe(true);
      expect(result.errors).toContain("orchestration.executionRoles must be a non-empty array");
    }
  });

  it("rejects non-objects and empty task lanes", () => {
    expect(validateWorkstreamTemplate(null).ok).toBe(false);
    expect(validateWorkstreamTemplate("nope").ok).toBe(false);
    const result = validateWorkstreamTemplate({ ...validTemplate, taskLanes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("taskLanes must be a non-empty array");
  });
});

describe("getWorkstreamTemplate with custom templates", () => {
  const custom: WorkstreamTemplate[] = [
    { ...validTemplate, roles: validTemplate.roles.map((r) => ({ ...r })), taskLanes: validTemplate.taskLanes.map((l) => ({ ...l })), orchestration: { ...validTemplate.orchestration, executionRoles: [...validTemplate.orchestration.executionRoles] } },
  ];

  it("prefers built-in templates over custom ones with the same id", () => {
    const clash: WorkstreamTemplate = { ...custom[0], id: "software-development" };
    expect(getWorkstreamTemplate("software-development", [clash])?.name).toBe("Software development");
  });

  it("resolves custom templates by id", () => {
    expect(getWorkstreamTemplate("podcast-production", custom)?.name).toBe("Podcast production");
    expect(getWorkstreamTemplate("podcast-production")).toBeUndefined();
  });
});
