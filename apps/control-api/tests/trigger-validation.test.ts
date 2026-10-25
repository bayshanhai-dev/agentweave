import { describe, expect, it } from "vitest";
import { buildTrigger } from "../src/trigger-validation.js";

const valid = {
  name: "Daily review",
  kind: "schedule",
  cronExpr: "0 9 * * *",
  timezone: "Europe/Paris",
  targetMode: "workstream",
  targetWorkstreamId: "ws-1",
  dutyTitle: "Review progress",
  dutyPrompt: "Review work for {{date}}",
};

describe("trigger validation", () => {
  it("accepts a consistent five-field schedule", () => {
    expect(buildTrigger(valid)).toMatchObject({
      ok: true,
      trigger: { kind: "schedule", timezone: "Europe/Paris" },
    });
  });

  it("rejects invalid cron, timezone, and target combinations", () => {
    expect(buildTrigger({ ...valid, cronExpr: "* * * * * *" })).toEqual({
      ok: false,
      error: "invalid_cron",
    });
    expect(buildTrigger({ ...valid, timezone: "Mars/Olympus" })).toEqual({
      ok: false,
      error: "invalid_timezone",
    });
    expect(buildTrigger({ ...valid, targetWorkstreamId: undefined })).toEqual({
      ok: false,
      error: "invalid_targetWorkstreamId",
    });
    expect(buildTrigger({ ...valid, kind: "api" })).toEqual({
      ok: false,
      error: "cron_expr_not_allowed",
    });
    expect(
      buildTrigger({ ...valid, templateId: "software-development" }),
    ).toEqual({ ok: false, error: "create_target_fields_not_allowed" });
  });

  it("clears schedule-only and workstream-only fields when modes change", () => {
    const created = buildTrigger(valid);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = buildTrigger(
      {
        kind: "api",
        targetMode: "create",
        templateId: "software-development",
        goalTemplate: "Handle {{payload}}",
      },
      created.trigger,
    );
    expect(updated).toMatchObject({
      ok: true,
      trigger: {
        kind: "api",
        targetMode: "create",
        templateId: "software-development",
      },
    });
    if (updated.ok) {
      expect(updated.trigger.cronExpr).toBeUndefined();
      expect(updated.trigger.targetWorkstreamId).toBeUndefined();
    }
  });
});
