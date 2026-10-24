import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { WrittenArtifact } from "./artifact-quality.js";

export const maximumArtifactExcerptCharacters = 4_000;
export const maximumDependencyInputsCharacters = 12_000;

type ArtifactEvent = {
  type: string;
  taskId?: string;
  toolName?: string;
  output?: string;
  correlationId?: string;
};
type DependencyTask = {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
};

function parsedArtifact(output: string): WrittenArtifact | undefined {
  try {
    const parsed = JSON.parse(output) as { path?: unknown; content?: unknown };
    if (typeof parsed.path === "string" && typeof parsed.content === "string")
      return { path: parsed.path, content: parsed.content };
  } catch {
    // Most providers return a human-readable write receipt, not JSON.
  }
  return undefined;
}

export function writtenFilePath(output: string): string | undefined {
  const parsed = parsedArtifact(output);
  if (parsed) return parsed.path;
  return output.match(/(?:wrote|written)\s+\d+\s+bytes\s+(?:to|at)\s+(.+)$/im)?.[1]?.trim()
    ?? output.match(/(?:created|updated|wrote)\s+(?:file\s+)?["'`](.+?)["'`]$/im)?.[1]?.trim();
}

function safeWorkspacePath(workspaceRoot: string, artifactPath: string): string | undefined {
  const root = resolve(workspaceRoot);
  const target = resolve(root, isAbsolute(artifactPath) ? relative(root, artifactPath) : artifactPath);
  const fromRoot = relative(root, target);
  return !fromRoot.startsWith("..") && !isAbsolute(fromRoot) ? target : undefined;
}

function eventWritesForTask(
  events: readonly ArtifactEvent[],
  taskId: string,
  correlationId?: string,
  allAttempts = false,
): ArtifactEvent[] {
  const taskEvents = events.filter((event) => event.taskId === taskId);
  const latestBoundary = allAttempts ? -1 : taskEvents.findLastIndex((event) =>
    ["task.quality_rejected", "task.completed", "task.failed"].includes(event.type)
  );
  return taskEvents.slice(latestBoundary + 1).filter((event) =>
    event.type === "tool.completed" &&
    event.toolName?.toLowerCase() === "write_file" &&
    Boolean(event.output) &&
    (!correlationId || !event.correlationId || event.correlationId === correlationId)
  );
}

/** Loads the last content written to each path by a task attempt. */
export async function loadWrittenArtifacts(
  workspaceRoot: string,
  events: readonly ArtifactEvent[],
  taskId: string,
  correlationId?: string,
  allAttempts = false,
): Promise<WrittenArtifact[]> {
  const artifacts = new Map<string, WrittenArtifact>();
  for (const event of eventWritesForTask(events, taskId, correlationId, allAttempts)) {
    const output = event.output!;
    const embedded = parsedArtifact(output);
    const path = embedded?.path ?? writtenFilePath(output);
    if (!path) continue;
    if (embedded) {
      artifacts.set(path, embedded);
      continue;
    }
    const target = safeWorkspacePath(workspaceRoot, path);
    if (!target || !likelyTextArtifact(path)) continue;
    try {
      artifacts.set(path, { path, content: await readFile(target, "utf8") });
    } catch {
      // A deleted or binary artifact is not a written text deliverable to inject.
    }
  }
  return [...artifacts.values()];
}

function excerpt(artifact: WrittenArtifact): string {
  if (artifact.content.length <= maximumArtifactExcerptCharacters)
    return artifact.content;
  const notice = `\n[excerpt truncated at ${maximumArtifactExcerptCharacters} characters]`;
  return `${artifact.content.slice(0, maximumArtifactExcerptCharacters - notice.length)}${notice}`;
}

/** Formats done dependencies and their written artifacts for a downstream dispatch. */
export async function dependencyInputsSection(
  task: DependencyTask,
  tasks: readonly DependencyTask[],
  artifactsForTask: (taskId: string) => Promise<readonly WrittenArtifact[]>,
): Promise<string> {
  if (!task.dependencies.length) return "";
  const blocks: string[] = [];
  for (const dependencyId of task.dependencies) {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId);
    if (!dependency || dependency.status !== "done") continue;
    for (const artifact of await artifactsForTask(dependency.id)) {
      blocks.push(`From ${dependency.title}:\nFile: ${artifact.path}\n\n${excerpt(artifact)}`);
    }
  }
  if (!blocks.length) return "";
  const heading = "Inputs from earlier tasks:\n\n";
  const available = maximumDependencyInputsCharacters - heading.length;
  const body = blocks.join("\n\n---\n\n");
  if (body.length <= available) return `${heading}${body}`;
  const notice = `\n[dependency inputs truncated at ${maximumDependencyInputsCharacters} characters]`;
  return `${heading}${body.slice(0, Math.max(0, available - notice.length))}${notice}`;
}

export function appendDependencyInputs(content: string, section: string): string {
  return section ? `${content}\n\n${section}` : content;
}

export function likelyTextArtifact(path: string): boolean {
  return !new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".mp3", ".mp4"]).has(extname(path).toLowerCase());
}
