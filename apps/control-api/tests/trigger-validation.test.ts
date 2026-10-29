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
    expect(buildTrigger({ ...valid, stateKey: "release-watch" })).toMatchObject(
      {
        ok: true,
        trigger: {
          kind: "schedule",
          timezone: "Europe/Paris",
          stateKey: "release-watch",
        },
      },
    );
  });

  it("supports clearing the optional state key to restore the name fallback", () => {
    const created = buildTrigger({ ...valid, stateKey: "release-watch" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = buildTrigger({ stateKey: null }, created.trigger);
    expect(updated).toMatchObject({ ok: true });
    if (updated.ok) expect(updated.trigger.stateKey).toBeUndefined();
    expect(buildTrigger({ ...valid, stateKey: "" })).toEqual({
      ok: false,
      error: "invalid_stateKey",
    });
  });

  it("accepts and trims a target role, and clears it with null", () => {
    const created = buildTrigger({ ...valid, targetRole: "  qa  " });
    expect(created).toMatchObject({ ok: true, trigger: { targetRole: "qa" } });
    if (!created.ok) return;
    const cleared = buildTrigger({ targetRole: null }, created.trigger);
    expect(cleared).toMatchObject({ ok: true });
    if (cleared.ok) expect(cleared.trigger.targetRole).toBeUndefined();
    expect(buildTrigger({ ...valid, targetRole: "   " })).toEqual({
      ok: false,
      error: "invalid_targetRole",
    });
  });

  it("validates completion evidence modes and resets null to attestation", () => {
    expect(
      buildTrigger({ ...valid, completionEvidence: "attestation" }),
    ).toMatchObject({
      ok: true,
      trigger: { completionEvidence: "attestation" },
    });
    const deliverable = buildTrigger({
      ...valid,
      completionEvidence: "deliverable",
    });
    expect(deliverable).toMatchObject({
      ok: true,
      trigger: { completionEvidence: "deliverable" },
    });
    expect(buildTrigger({ ...valid, completionEvidence: "other" })).toEqual({
      ok: false,
      error: "invalid_completionEvidence",
    });
    if (deliverable.ok)
      expect(
        buildTrigger({ completionEvidence: null }, deliverable.trigger),
      ).toMatchObject({
        ok: true,
        trigger: { completionEvidence: "attestation" },
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

  it("accepts, clears, and rejects out-of-range load-gate settings", () => {
    const created = buildTrigger({ ...valid, maxOpenTasks: 4 });
    expect(created).toMatchObject({ ok: true, trigger: { maxOpenTasks: 4 } });
    expect(buildTrigger({ ...valid, maxOpenTasks: 0 })).toMatchObject({
      ok: true,
      trigger: { maxOpenTasks: 0 },
    });
    expect(buildTrigger({ ...valid, maxOpenTasks: -1 })).toEqual({
      ok: false,
      error: "invalid_max_open_tasks",
    });
    expect(buildTrigger({ ...valid, maxOpenTasks: 1.5 })).toEqual({
      ok: false,
      error: "invalid_maxOpenTasks",
    });
    if (!created.ok) return;
    const cleared = buildTrigger({ maxOpenTasks: null }, created.trigger);
    expect(cleared).toMatchObject({ ok: true });
    if (cleared.ok) expect(cleared.trigger.maxOpenTasks).toBeUndefined();
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
