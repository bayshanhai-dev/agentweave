import { describe, expect, it } from "vitest";
import { resolveDutyAssignee } from "../src/duty-assignment.js";

const agents = [
  { id: "pm-1", role: "pm" },
  { id: "qa-1", role: "qa" },
];

describe("duty assignment", () => {
  it("resolves the lead by default", () => {
    expect(resolveDutyAssignee(agents, "pm")).toEqual({
      agent: agents[0],
      ownerRole: "pm",
    });
  });

  it("resolves an explicit target role", () => {
    expect(resolveDutyAssignee(agents, "pm", "qa")).toEqual({
      agent: agents[1],
      ownerRole: "qa",
    });
  });

  it("fails when a target role is missing or ambiguous", () => {
    expect(() => resolveDutyAssignee(agents, "pm", "backend")).toThrow(
      "trigger-target-role-not-found",
    );
    expect(() =>
      resolveDutyAssignee([...agents, { id: "qa-2", role: "qa" }], "pm", "qa"),
    ).toThrow("trigger-target-role-ambiguous");
    expect(() => resolveDutyAssignee(agents, "missing")).toThrow(
      "target-lead-not-found",
    );
  });
});
