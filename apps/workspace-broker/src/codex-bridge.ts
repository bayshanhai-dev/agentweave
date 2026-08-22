import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type CodexExecution = { prompt: string; workspacePath: string; model?: string };
export type CodexExecutionResult = { text: string; stderr: string; exitCode: number | null };

/** Host-side boundary for Codex. It never accepts a shell command string. */
export class CodexBridge {
  private readonly roots: string[];
  constructor(private readonly options: { allowedRoots?: string[]; command?: string } = {}) { this.roots = (options.allowedRoots ?? (process.env.WORKSPACE_ALLOWED_ROOTS ?? process.cwd()).split(",")).map(resolve); }
  async execute(input: CodexExecution): Promise<CodexExecutionResult> {
    const workspacePath = await realpath(input.workspacePath); await access(workspacePath);
    const relativePath = relative(this.roots.find((root) => workspacePath === root || (!relative(root, workspacePath).startsWith(`..${sep}`) && !isAbsolute(relative(root, workspacePath)))) ?? this.roots[0]!, workspacePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("workspace_path_not_allowed");
    const args = ["exec", "--json", "--cd", workspacePath, "--sandbox", "workspace-write", "--ask-for-approval", "never", ...(input.model ? ["--model", input.model] : []), input.prompt];
    return new Promise((resolve, reject) => { const child = spawn(this.options.command ?? process.env.CODEX_COMMAND ?? "codex", args, { shell: false, cwd: workspacePath }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.on("error", reject); child.on("close", (exitCode) => resolve({ text: stdout, stderr, exitCode })); });
  }
}
