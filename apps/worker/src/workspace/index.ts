import { access, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";

const exec = promisify(execFile);
export type WorkspaceEvidence = { taskId: string; workspacePath: string; gitDiff: string; testCommand?: string; testOutput?: string; testExitCode?: number; createdAt: string };
export function validateWorkspacePath(workspacePath: string, root = process.env.WORKSPACE_ROOT ?? "/workspaces"): string {
  const resolved = resolve(workspacePath); const rootResolved = resolve(root); const rel = relative(rootResolved, resolved);
  if (!isAbsolute(resolved) || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Workspace path is outside WORKSPACE_ROOT: ${workspacePath}`);
  return resolved;
}
export async function assertWorkspace(workspacePath: string): Promise<void> { await access(workspacePath); if (!(await stat(workspacePath)).isDirectory()) throw new Error(`Workspace is not a directory: ${workspacePath}`); }
export async function collectWorkspaceEvidence(taskId: string, workspacePath: string, testCommand?: string): Promise<WorkspaceEvidence> {
  const diff = await exec("git", ["diff", "--no-ext-diff", "--binary"], { cwd: workspacePath, maxBuffer: 4 * 1024 * 1024 });
  const evidence: WorkspaceEvidence = { taskId, workspacePath, gitDiff: diff.stdout, ...(testCommand ? { testCommand } : {}), createdAt: new Date().toISOString() };
  if (testCommand) { try { const result = await exec("sh", ["-lc", testCommand], { cwd: workspacePath, maxBuffer: 4 * 1024 * 1024 }); evidence.testOutput = result.stdout + result.stderr; evidence.testExitCode = 0; } catch (error) { const failure = error as { stdout?: string; stderr?: string; code?: number }; evidence.testOutput = (failure.stdout ?? "") + (failure.stderr ?? ""); evidence.testExitCode = typeof failure.code === "number" ? failure.code : 1; } }
  return evidence;
}
export async function persistWorkspaceEvidence(evidence: WorkspaceEvidence): Promise<string> { const sql = postgres(process.env.DATABASE_URL ?? "postgres://agentweave:agentweave@localhost:5432/agentweave"); const rows = await sql`insert into workspace_evidence (task_id, workspace_path, git_diff, test_command, test_output, test_exit_code, created_at) values (${evidence.taskId}, ${evidence.workspacePath}, ${evidence.gitDiff}, ${evidence.testCommand ?? null}, ${evidence.testOutput ?? null}, ${evidence.testExitCode ?? null}, ${evidence.createdAt}) returning id`; await sql.end(); return String(rows[0]?.id ?? `${evidence.taskId}:evidence`); }
