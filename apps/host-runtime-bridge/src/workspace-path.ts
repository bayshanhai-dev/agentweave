import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export function mapWorkspacePath(input: string): string {
  const containerRoot = process.env.CODEX_CONTAINER_WORKSPACE_ROOT ?? "/workspaces";
  // Keep manual host-bridge startup aligned with the Docker worker mount.
  // A repository-local workspace is a portable default; operators can point
  // this at a different *narrow, allowlisted* directory for a real project.
  const hostRoot = process.env.CODEX_HOST_WORKSPACE_ROOT ?? join(process.cwd(), "workspaces");
  const path = resolve(input);
  const rel = relative(resolve(containerRoot), path);
  if (rel === "") return resolve(hostRoot);
  const mapped = join(resolve(hostRoot), rel);
  if (existsSync(mapped)) return mapped;
  return mapped;
}
