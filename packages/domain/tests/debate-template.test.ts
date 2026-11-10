import { describe, expect, it } from "vitest";
import { getWorkstreamTemplate } from "../src/index.js";

describe("debate templates", () => {
  it.each(["debate", "debate-en"]) ("contains the complete %s debate contract", (id) => {
    const template = getWorkstreamTemplate(id)!;
    expect(template.roles.map((role) => role.id)).toEqual(["moderator", "pro", "con"]);
    expect(template.orchestration).toEqual({ leadRole: "moderator", planningRole: "moderator", executionRoles: ["pro", "con"], reviewRole: "moderator" });
    expect(template.goalPrompt).toContain(id === "debate" ? "开场 → 正方开篇 → 反方开篇 → 正方反驳 → 反方反驳 → 正方自由交锋 → 反方自由交锋 → 裁决" : "opening → pro opening → con opening → pro rebuttal → con rebuttal → pro free exchange → con free exchange → verdict");
    expect(template.roles[0]?.description).toMatch(/dispatch|派发/);
    expect(template.roles[0]?.description).toMatch(/structured|结构化/);
  });
});
