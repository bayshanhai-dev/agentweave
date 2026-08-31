import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mapWorkspacePath } from "./workspace-path.js";

export type CodexExecution = { prompt: string; workspacePath: string; model?: string };
export type CodexExecutionResult = { text: string; stderr: string; exitCode: number | null; threadId?: string };

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function extractText(stdout: string): string {
  const values = stdout.split("\n").flatMap((line) => { try { return stringsIn(JSON.parse(line)); } catch { return [line]; } });
  return values.find((value) => value.includes("[CLARIFICATION_REQUEST]")) ?? values.filter((value) => value.trim()).at(-1) ?? stdout;
}

/** Host-side boundary for Codex. It never accepts a shell command string. */
export class CodexBridge {
  private readonly roots: string[];
  constructor(private readonly options: { allowedRoots?: string[]; command?: string } = {}) {
    const configuredRoots = process.env.WORKSPACE_ALLOWED_ROOTS ?? process.env.CODEX_HOST_WORKSPACE_ROOT ?? resolve(process.cwd(), "workspaces");
    this.roots = (options.allowedRoots ?? configuredRoots.split(",")).map((root) => resolve(root));
  }
  async execute(input: CodexExecution & { threadId?: string }): Promise<CodexExecutionResult> {
    const workspacePath = await realpath(mapWorkspacePath(input.workspacePath)); await access(workspacePath);
    const relativePath = relative(this.roots.find((root) => workspacePath === root || (!relative(root, workspacePath).startsWith(`..${sep}`) && !isAbsolute(relative(root, workspacePath)))) ?? this.roots[0]!, workspacePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("workspace_path_not_allowed");
    const clarificationOnly = input.prompt.includes("[CLARIFICATION_REQUEST]");
    const args = input.threadId
      ? ["exec", "resume", "--json", ...(input.model ? ["--model", input.model] : []), input.threadId, input.prompt]
      : ["exec", "--json", "--cd", workspacePath, "--sandbox", clarificationOnly ? "read-only" : "workspace-write", ...(input.model ? ["--model", input.model] : []), input.prompt];
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command ?? process.env.CODEX_COMMAND ?? "codex", args, { shell: false, cwd: workspacePath });
      let stdout = ""; let stderr = ""; let settled = false;
      const timeoutMs = Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS ?? 120_000);
      const findThreadId = (): string | undefined => { for (const line of stdout.split("\n")) { try { const event = JSON.parse(line) as { type?: string; thread_id?: string; threadId?: string }; if (event.type === "thread.started") return event.thread_id ?? event.threadId; } catch { /* Ignore non-JSON CLI output. */ } } return undefined; };
      const finish = (exitCode: number | null, timedOut = false): void => { if (settled) return; settled = true; clearTimeout(timer); const threadId = findThreadId(); resolve({ text: extractText(stdout), stderr: `${stderr}${timedOut ? `Codex provider timed out after ${timeoutMs}ms` : ""}`, exitCode, ...(threadId ? { threadId } : {}) }); };
      const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2_000).unref(); setTimeout(() => finish(null, true), 2_500).unref(); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); if (clarificationOnly && stdout.includes("[CLARIFICATION_REQUEST]")) { finish(0); child.kill("SIGTERM"); } });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
      child.on("close", (exitCode) => finish(exitCode));
    });
  }
}
