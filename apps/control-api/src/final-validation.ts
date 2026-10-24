import type { TaskSpec } from "./orchestrator.js";

export const finalValidationTaskTitle =
  "Final validation: run the full project suite";

const requiredCriteria = [
  "Run the project's full test command in the workspace and report the command and its verbatim result",
  "Run the project's full build command when one is defined and report the command and its verbatim result",
  "Report failures without fixing them so the Human can decide whether to complete or reject the Workstream",
];

export function isFinalValidationTask(task: { title: string }): boolean {
  return /\bfinal\b.*\bvalidat(?:e|ion)\b|\bvalidat(?:e|ion)\b.*\bfinal\b/i.test(
    task.title,
  );
}

/** Ensure decomposition ends with one validation task that cannot run before the implementation tasks. */
export function withFinalValidationTask(specs: TaskSpec[], reviewRole = "qa"): TaskSpec[] {
  const existing = specs.find(isFinalValidationTask);
  const implementation = specs.filter((spec) => spec !== existing);
  const validation: TaskSpec = {
    ...(existing ?? {}),
    title: existing?.title ?? finalValidationTaskTitle,
    ownerRole: reviewRole,
    acceptanceCriteria: [
      ...new Set([
        ...(existing?.acceptanceCriteria ?? []),
        ...requiredCriteria,
      ]),
    ],
    dependsOnAllPrevious: true,
  };
  return [...implementation, validation];
}
