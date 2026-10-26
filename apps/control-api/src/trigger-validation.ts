import { randomUUID } from "node:crypto";
import {
  validClock,
  validateCron,
  validateTimezone,
  type Trigger,
} from "./trigger-scheduler.js";

type ValidationResult =
  | { ok: true; trigger: Trigger }
  | { ok: false; error: string };

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() : undefined;
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

export function buildTrigger(
  body: unknown,
  existing?: Trigger,
): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "invalid_trigger" };
  const value = body as Record<string, unknown>;
  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);
  for (const key of [
    "name",
    "timezone",
    "dutyTitle",
    "dutyPrompt",
    "cronExpr",
    "targetWorkstreamId",
    "templateId",
    "goalTemplate",
  ]) {
    if (has(key) && typeof value[key] !== "string")
      return { ok: false, error: `invalid_${key}` };
    if (has(key) && typeof value[key] === "string" && !value[key].trim())
      return { ok: false, error: `invalid_${key}` };
  }
  for (const key of ["priority", "maxRunsPerDay", "batchWindowSec"]) {
    if (has(key) && value[key] !== null && integer(value[key]) === undefined)
      return { ok: false, error: `invalid_${key}` };
  }
  for (const key of ["quietStart", "quietEnd"]) {
    if (has(key) && value[key] !== null && typeof value[key] !== "string")
      return { ok: false, error: `invalid_${key}` };
  }
  if (
    has("stateKey") &&
    value.stateKey !== null &&
    (typeof value.stateKey !== "string" || !value.stateKey.trim())
  )
    return { ok: false, error: "invalid_stateKey" };
  const now = new Date().toISOString();
  const kind = (value.kind ?? existing?.kind) as Trigger["kind"] | undefined;
  const targetMode = (value.targetMode ?? existing?.targetMode) as
    | Trigger["targetMode"]
    | undefined;
  const timezone = text(value.timezone) ?? existing?.timezone ?? "UTC";
  const name = text(value.name) ?? existing?.name;
  const dutyTitle = text(value.dutyTitle) ?? existing?.dutyTitle;
  const dutyPrompt = text(value.dutyPrompt) ?? existing?.dutyPrompt;
  const stateKey = value.stateKey === null
    ? undefined
    : (text(value.stateKey) ?? existing?.stateKey);
  const cronExpr =
    kind === "schedule"
      ? (text(value.cronExpr) ?? existing?.cronExpr)
      : undefined;
  const targetWorkstreamId =
    targetMode === "workstream"
      ? (text(value.targetWorkstreamId) ?? existing?.targetWorkstreamId)
      : undefined;
  const templateId =
    targetMode === "create"
      ? (text(value.templateId) ?? existing?.templateId)
      : undefined;
  const goalTemplate =
    targetMode === "create"
      ? (text(value.goalTemplate) ?? existing?.goalTemplate)
      : undefined;
  const quietStart =
    value.quietStart === null
      ? undefined
      : (text(value.quietStart) ?? existing?.quietStart);
  const quietEnd =
    value.quietEnd === null
      ? undefined
      : (text(value.quietEnd) ?? existing?.quietEnd);
  const maxRunsPerDay =
    value.maxRunsPerDay === null
      ? undefined
      : (integer(value.maxRunsPerDay) ?? existing?.maxRunsPerDay);
  const priority = integer(value.priority) ?? existing?.priority ?? 0;
  const batchWindowSec =
    integer(value.batchWindowSec) ?? existing?.batchWindowSec ?? 0;
  const overlapPolicy = (value.overlapPolicy ??
    existing?.overlapPolicy ??
    "skip") as Trigger["overlapPolicy"];

  if (!name || !dutyTitle || !dutyPrompt)
    return { ok: false, error: "name_duty_title_and_prompt_required" };
  if (kind !== "schedule" && kind !== "api")
    return { ok: false, error: "invalid_kind" };
  if (!validateTimezone(timezone))
    return { ok: false, error: "invalid_timezone" };
  if (kind === "schedule" && (!cronExpr || !validateCron(cronExpr, timezone)))
    return { ok: false, error: "invalid_cron" };
  if (kind === "api" && has("cronExpr"))
    return { ok: false, error: "cron_expr_not_allowed" };
  if (targetMode !== "workstream" && targetMode !== "create")
    return { ok: false, error: "invalid_target_mode" };
  if (targetMode === "workstream" && !targetWorkstreamId)
    return { ok: false, error: "target_workstream_id_required" };
  if (targetMode === "create" && (!templateId || !goalTemplate))
    return { ok: false, error: "template_id_and_goal_template_required" };
  if (targetMode === "workstream" && (has("templateId") || has("goalTemplate")))
    return { ok: false, error: "create_target_fields_not_allowed" };
  if (targetMode === "create" && has("targetWorkstreamId"))
    return { ok: false, error: "workstream_target_field_not_allowed" };
  if ((quietStart === undefined) !== (quietEnd === undefined))
    return { ok: false, error: "quiet_hours_pair_required" };
  if (
    (quietStart && !validClock(quietStart)) ||
    (quietEnd && !validClock(quietEnd))
  )
    return { ok: false, error: "invalid_quiet_hours" };
  if (maxRunsPerDay !== undefined && maxRunsPerDay <= 0)
    return { ok: false, error: "invalid_max_runs_per_day" };
  if (batchWindowSec < 0) return { ok: false, error: "invalid_batch_window" };
  if (overlapPolicy !== "skip" && overlapPolicy !== "allow")
    return { ok: false, error: "invalid_overlap_policy" };
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    return { ok: false, error: "invalid_enabled" };

  return {
    ok: true,
    trigger: {
      id: existing?.id ?? randomUUID(),
      name,
      enabled:
        (value.enabled as boolean | undefined) ?? existing?.enabled ?? true,
      kind,
      ...(cronExpr ? { cronExpr } : {}),
      timezone,
      targetMode,
      ...(targetWorkstreamId ? { targetWorkstreamId } : {}),
      ...(templateId ? { templateId } : {}),
      ...(goalTemplate ? { goalTemplate } : {}),
      dutyTitle,
      dutyPrompt,
      ...(stateKey ? { stateKey } : {}),
      priority,
      ...(maxRunsPerDay !== undefined ? { maxRunsPerDay } : {}),
      ...(quietStart ? { quietStart } : {}),
      ...(quietEnd ? { quietEnd } : {}),
      batchWindowSec,
      overlapPolicy,
      ...(existing?.lastFiredAt ? { lastFiredAt: existing.lastFiredAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  };
}
