import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export function mapWorkspacePath(input: string): string {
  const containerRoot = process.env.CODEX_CONTAINER_WORKSPACE_ROOT ?? "/workspaces";
  // Keep manual host-bridge startup aligned with the Docker worker mount.
  // Operators can override this for another host workspace layout.
  const hostRoot = process.env.CODEX_HOST_WORKSPACE_ROOT ?? "/Users/tong/Documents/ChatGPT";
  const path = resolve(input);
  const rel = relative(resolve(containerRoot), path);
  if (rel === "") return resolve(hostRoot);
  const mapped = join(resolve(hostRoot), rel);
  if (existsSync(mapped)) return mapped;
  // The Docker mount intentionally uses a URL-safe lowercase slug while the
  // host project uses its product casing. Keep the mapping tolerant of that
  // boundary without changing the container contract.
  if (rel.toLowerCase() === "academic-paper-buddy") {
    const productCased = join(resolve(hostRoot), "AcademicPaperBuddy");
    if (existsSync(productCased)) return productCased;
  }
  return mapped;
}
