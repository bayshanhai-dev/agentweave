import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mapWorkspacePath } from "./workspace-path.js";

export type CodexExecution = { prompt: string; workspacePath: string; model?: string };
export type CodexExecutionResult = { text: string; stderr: string; exitCode: number | null; threadId?: string };

/** Host-side boundary for Codex. It never accepts a shell command string. */
export class CodexBridge {
  private readonly roots: string[];
  constructor(private readonly options: { allowedRoots?: string[]; command?: string } = {}) { this.roots = (options.allowedRoots ?? (process.env.WORKSPACE_ALLOWED_ROOTS ?? "/Users/tong/Documents/ChatGPT/AcademicPaperBuddy").split(",")).map((root) => resolve(root)); }
  async execute(input: CodexExecution & { threadId?: string }): Promise<CodexExecutionResult> {
    const workspacePath = await realpath(mapWorkspacePath(input.workspacePath)); await access(workspacePath);
    const relativePath = relative(this.roots.find((root) => workspacePath === root || (!relative(root, workspacePath).startsWith(`..${sep}`) && !isAbsolute(relative(root, workspacePath)))) ?? this.roots[0]!, workspacePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("workspace_path_not_allowed");
    const args = input.threadId
      ? ["exec", "resume", "--json", ...(input.model ? ["--model", input.model] : []), input.threadId, input.prompt]
      : ["exec", "--json", "--cd", workspacePath, "--sandbox", "workspace-write", ...(input.model ? ["--model", input.model] : []), input.prompt];
    return new Promise((resolve, reject) => { const child = spawn(this.options.command ?? process.env.CODEX_COMMAND ?? "codex", args, { shell: false, cwd: workspacePath }); let stdout = ""; let stderr = ""; const timeoutMs = Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS ?? 120_000); const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2_000).unref(); }, timeoutMs); child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.on("error", (error) => { clearTimeout(timer); reject(error); }); child.on("close", (exitCode) => { clearTimeout(timer); let threadId: string | undefined; for (const line of stdout.split("\n")) { try { const event = JSON.parse(line) as { type?: string; thread_id?: string; threadId?: string }; if (event.type === "thread.started") threadId = event.thread_id ?? event.threadId; } catch { /* Ignore non-JSON CLI output. */ } } resolve({ text: stdout, stderr: `${stderr}${exitCode === null ? `Codex provider timed out after ${timeoutMs}ms` : ""}`, exitCode, ...(threadId ? { threadId } : {}) }); }); });
  }
}
