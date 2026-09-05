import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
const blocks = [...readme.matchAll(/^```mermaid[^\n]*\r?\n([\s\S]*?)^```/gm)].map(
  (match) => match[1],
);

if (!blocks.length) throw new Error("README.md contains no Mermaid diagrams");

const directory = await mkdtemp(join(tmpdir(), "agentweave-readme-mermaid-"));
try {
  const puppeteerConfig = join(directory, "puppeteer-config.json");
  await writeFile(
    puppeteerConfig,
    JSON.stringify({ args: ["--no-sandbox", "--disable-setuid-sandbox"] }),
  );

  for (const [index, source] of blocks.entries()) {
    const input = join(directory, `diagram-${index + 1}.mmd`);
    const output = join(directory, `diagram-${index + 1}.svg`);
    await writeFile(input, source);
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const rendered = spawnSync(
      command,
      ["exec", "mmdc", "-p", puppeteerConfig, "-i", input, "-o", output, "-b", "white"],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
    if (rendered.status !== 0)
      throw new Error(`README Mermaid diagram ${index + 1} failed to render`);
  }
  console.log(`Rendered ${blocks.length} README Mermaid diagram${blocks.length === 1 ? "" : "s"}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
