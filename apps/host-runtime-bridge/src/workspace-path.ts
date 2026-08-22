import { join, relative, resolve } from "node:path";

export function mapWorkspacePath(input: string): string {
  const containerRoot = process.env.CODEX_CONTAINER_WORKSPACE_ROOT ?? "/workspaces";
  // Keep manual host-bridge startup aligned with the Docker worker mount.
  // Operators can override this for another host workspace layout.
  const hostRoot = process.env.CODEX_HOST_WORKSPACE_ROOT ?? "/Users/tong/Documents/ChatGPT";
  const path = resolve(input);
  const rel = relative(resolve(containerRoot), path);
  return rel === "" ? resolve(hostRoot) : join(resolve(hostRoot), rel);
}
