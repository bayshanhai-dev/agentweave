export const workstreamStatuses = [
  "draft",
  "starting",
  "active",
  "waiting_for_human",
  "pausing",
  "paused",
  "resuming",
  "completing",
  "completed",
  "emergency_stopped",
  "archived",
] as const;

export type WorkstreamStatus = (typeof workstreamStatuses)[number];

const transitions: Record<WorkstreamStatus, readonly WorkstreamStatus[]> = {
  draft: ["starting", "archived"],
  starting: ["active", "pausing"],
  active: ["waiting_for_human", "pausing", "completing"],
  waiting_for_human: ["active", "pausing", "completing"],
  pausing: ["paused"],
  paused: ["resuming", "archived"],
  resuming: ["active", "waiting_for_human", "pausing"],
  completing: ["active", "completed"],
  completed: ["active", "archived"],
  emergency_stopped: ["archived"],
  archived: [],
};

export function canTransition(from: WorkstreamStatus, to: WorkstreamStatus): boolean {
  return transitions[from].includes(to);
}
