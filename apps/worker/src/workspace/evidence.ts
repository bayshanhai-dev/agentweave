import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceEvidence } from "./index.js";

const exec = promisify(execFile);
export type Evidence = WorkspaceEvidence & { kind: "git_diff" | "command_output" | "file_snapshot"; warnings?: string[] };
export type EvidenceCollector = { readonly name: string; collect(input: { taskId: string; workspacePath?: string; commands?: string[] }): Promise<Evidence[]> };

export class GitEvidenceCollector implements EvidenceCollector {
  readonly name = "git";
  async collect(input: { taskId: string; workspacePath?: string }): Promise<Evidence[]> {
    if (!input.workspacePath) return [];
    try { const result = await exec("git", ["diff", "--no-ext-diff", "--binary"], { cwd: input.workspacePath, maxBuffer: 4 * 1024 * 1024 }); return [{ taskId: input.taskId, workspacePath: input.workspacePath, gitDiff: result.stdout, kind: "git_diff", createdAt: new Date().toISOString() }]; }
    catch (error) { return [{ taskId: input.taskId, workspacePath: input.workspacePath, gitDiff: "", kind: "git_diff", warnings: [`git evidence unavailable: ${error instanceof Error ? error.message : String(error)}`], createdAt: new Date().toISOString() }]; }
  }
}

export class CommandEvidenceCollector implements EvidenceCollector {
  readonly name = "command";
  async collect(input: { taskId: string; workspacePath?: string; commands?: string[] }): Promise<Evidence[]> {
    if (!input.workspacePath) return [];
    const results: Evidence[] = input.commands?.length ? [] : [{ taskId: input.taskId, workspacePath: input.workspacePath, gitDiff: "", kind: "command_output", testOutput: "QA command not configured; not run", warnings: ["QA_NOT_CONFIGURED"], createdAt: new Date().toISOString() }];
    for (const command of input.commands ?? []) { try { const result = await exec("sh", ["-lc", command], { cwd: input.workspacePath, maxBuffer: 4 * 1024 * 1024 }); results.push({ taskId: input.taskId, workspacePath: input.workspacePath, gitDiff: "", kind: "command_output", testCommand: command, testOutput: result.stdout + result.stderr, testExitCode: 0, createdAt: new Date().toISOString() }); } catch (error) { const failure = error as { stdout?: string; stderr?: string; code?: number }; results.push({ taskId: input.taskId, workspacePath: input.workspacePath, gitDiff: "", kind: "command_output", testCommand: command, testOutput: (failure.stdout ?? "") + (failure.stderr ?? ""), testExitCode: typeof failure.code === "number" ? failure.code : 1, warnings: ["command exited non-zero"], createdAt: new Date().toISOString() }); } }
    return results;
  }
}

export class EvidenceCollectorRegistry {
  constructor(private readonly collectors: EvidenceCollector[] = [new GitEvidenceCollector(), new CommandEvidenceCollector()]) {}
  async collect(input: { taskId: string; workspacePath?: string; commands?: string[] }): Promise<Evidence[]> { return (await Promise.all(this.collectors.map((collector) => collector.collect(input)))).flat(); }
}
