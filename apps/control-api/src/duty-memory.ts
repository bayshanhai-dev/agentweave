import type { Trigger } from "./trigger-scheduler.js";

export const DUTY_STATE_MAX_BYTES = 32 * 1024;
export const dutyStateWritebackContract =
  "To update your memory for the next cycle, include a dutyState object in your structured result when you complete this duty; it fully replaces the stored state under this key. Keep it compact: per-issue conclusions and timestamps, not raw logs.";

export function effectiveDutyStateKey(
  trigger: Pick<Trigger, "name" | "stateKey">,
): string {
  return trigger.stateKey ?? trigger.name;
}

export function appendDutyMemory(
  prompt: string,
  key: string,
  state?: Record<string, unknown>,
): string {
  const hasState = state !== undefined && Object.keys(state).length > 0;
  const section = hasState
    ? [
        `## Duty memory (key: ${key}) — your state from previous cycles`,
        JSON.stringify(state, null, 2),
        "Continue from this state. Do not redo work it records as done.",
      ]
    : [
        `## Duty memory (key: ${key})`,
        "No stored state yet — this is your first recorded cycle.",
      ];
  return [prompt, "", ...section, dutyStateWritebackContract].join("\n");
}

export async function dutyPromptForFire(
  trigger: Pick<Trigger, "name" | "stateKey" | "targetMode">,
  workstreamId: string,
  prompt: string,
  getState: (
    workstreamId: string,
    key: string,
  ) => Promise<{ state: Record<string, unknown> } | undefined>,
): Promise<string> {
  if (trigger.targetMode !== "workstream") return prompt;
  const key = effectiveDutyStateKey(trigger);
  const stored = await getState(workstreamId, key);
  return appendDutyMemory(prompt, key, stored?.state);
}

export type DutyContext = {
  triggerId: string;
  workstreamId: string;
  stateKey: string;
  completionEvidence?: string;
};

export type DutyStateWritebackResult =
  | { status: "ignored" }
  | { status: "updated"; key: string }
  | { status: "rejected"; key: string; reason: string };

type DutyStateWritebackDependencies = {
  findDutyContextByTaskId: (taskId: string) => Promise<DutyContext | undefined>;
  upsert: (
    workstreamId: string,
    key: string,
    state: Record<string, unknown>,
  ) => Promise<unknown>;
  recordEvent: (
    type: "duty.state_updated" | "duty.state_rejected",
    message: string,
  ) => void;
  logError?: (error: unknown, context: DutyContext) => void;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function applyDutyStateWriteback(
  taskId: string,
  dutyState: unknown,
  dependencies: DutyStateWritebackDependencies,
): Promise<DutyStateWritebackResult> {
  if (dutyState === undefined) return { status: "ignored" };
  const context = await dependencies.findDutyContextByTaskId(taskId);
  if (!context) return { status: "ignored" };

  const reject = (reason: string): DutyStateWritebackResult => {
    dependencies.recordEvent(
      "duty.state_rejected",
      `Duty memory rejected for key ${context.stateKey}: ${reason}`,
    );
    return { status: "rejected", key: context.stateKey, reason };
  };

  if (!plainObject(dutyState))
    return reject("dutyState must be a plain JSON object");

  let serialized: string;
  try {
    serialized = JSON.stringify(dutyState);
  } catch {
    return reject("dutyState must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > DUTY_STATE_MAX_BYTES)
    return reject("serialized dutyState exceeds 32 KB");

  try {
    await dependencies.upsert(
      context.workstreamId,
      context.stateKey,
      dutyState,
    );
    dependencies.recordEvent(
      "duty.state_updated",
      `Duty memory updated for key ${context.stateKey}`,
    );
    return { status: "updated", key: context.stateKey };
  } catch (error) {
    dependencies.logError?.(error, context);
    return reject("state persistence failed; previous state was kept");
  }
}
