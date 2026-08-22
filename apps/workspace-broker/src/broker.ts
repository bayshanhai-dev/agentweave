import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type WorkspaceBinding = { workstreamId: string; hostPath: string; containerPath: string; containerName: string; readOnly: boolean; status: "running" | "stopped" };
export type DockerRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class WorkspaceBroker {
  private readonly roots: string[];
  private readonly bindings = new Map<string, WorkspaceBinding>();
  constructor(private readonly options: { allowedRoots?: string[]; containerRoot?: string; network?: string; workerImage?: string; docker?: DockerRunner } = {}) { this.roots = (options.allowedRoots ?? (process.env.WORKSPACE_ALLOWED_ROOTS ?? process.cwd()).split(",")).map(resolve); }
  async bind(input: { workstreamId: string; hostPath: string; readOnly?: boolean; agentId?: string }): Promise<WorkspaceBinding> {
    const hostPath = await realpath(input.hostPath); await access(hostPath);
    if (!this.roots.some((root) => hostPath === root || (!relative(root, hostPath).startsWith(`..${sep}`) && !isAbsolute(relative(root, hostPath))))) throw new Error("workspace_path_not_allowed");
    const safeId = input.workstreamId.replace(/[^a-zA-Z0-9_.-]/g, "-"); const containerName = `agentweave-worker-${safeId}`; const containerPath = this.options.containerRoot ?? "/workspace"; const readOnly = input.readOnly ?? false;
    const docker = this.options.docker ?? (async (args: string[]) => exec("docker", args));
    await docker(["rm", "-f", containerName]).catch(() => undefined);
    const mount = `${hostPath}:${containerPath}${readOnly ? ":ro" : ""}`;
    await docker(["create", "--name", containerName, "--network", this.options.network ?? process.env.WORKSPACE_DOCKER_NETWORK ?? "agentweave_default", "-e", `WORKSTREAM_ID=${input.workstreamId}`, ...(input.agentId ? ["-e", `AGENT_ID=${input.agentId}`] : []), "-e", `NATS_URL=${process.env.WORKER_NATS_URL ?? "nats://nats:4222"}`, "-e", `DATABASE_URL=${process.env.WORKER_DATABASE_URL ?? "postgresql://agentweave:agentweave@postgres:5432/agentweave"}`, "-v", mount, this.options.workerImage ?? process.env.WORKER_IMAGE ?? "agentweave-worker"]);
    await docker(["start", containerName]);
    const binding: WorkspaceBinding = { workstreamId: input.workstreamId, hostPath, containerPath, containerName, readOnly, status: "running" }; this.bindings.set(input.workstreamId, binding); return binding;
  }
  async stop(workstreamId: string): Promise<void> { const binding = this.bindings.get(workstreamId); if (!binding) return; const docker = this.options.docker ?? (async (args: string[]) => exec("docker", args)); await docker(["rm", "-f", binding.containerName]).catch(() => undefined); this.bindings.delete(workstreamId); }
  get(workstreamId: string): WorkspaceBinding | undefined { return this.bindings.get(workstreamId); }
}
