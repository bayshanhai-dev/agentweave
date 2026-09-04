import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiUrl = process.env.CONTROL_API_URL ?? "http://localhost:3000";
const bridgeUrl = process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:3010";
const hostRoot = resolve(process.env.CODEX_HOST_WORKSPACE_ROOT ?? "");
const containerRoot =
  process.env.CODEX_CONTAINER_WORKSPACE_ROOT ?? "/workspaces";
const timeoutMs = Number(
  process.env.CODEX_WORKSTREAM_SMOKE_TIMEOUT_MS ?? 600_000,
);
const bridgeToken = process.env.CODEX_BRIDGE_TOKEN?.trim();

if (!process.env.CODEX_HOST_WORKSPACE_ROOT?.trim()) {
  throw new Error(
    "CODEX_HOST_WORKSPACE_ROOT must name the narrow host directory mounted into the Worker.",
  );
}
if (process.env.CODEX_WORKSTREAM_SMOKE_ALLOW_WRITE !== "YES") {
  throw new Error(
    "Refusing a real edit without CODEX_WORKSTREAM_SMOKE_ALLOW_WRITE=YES.",
  );
}

const fixtureName = `agentweave-codex-smoke-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const fixtureHostPath = join(hostRoot, fixtureName);
const fixtureContainerPath = join(containerRoot, fixtureName);
const reportPath = join(fixtureHostPath, "agentweave-smoke-report.json");
const expected = "AgentWeave Codex smoke OK\n";

const api = async (path, init) => {
  const response = await fetch(`${apiUrl}${path}`, init);
  if (!response.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`,
    );
  return response.json();
};

const waitFor = async (description, check) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
};

let workstreamId;
let latest;
try {
  const nested = relative(hostRoot, fixtureHostPath);
  if (!nested || nested.startsWith(`..${sep}`))
    throw new Error("Fixture escaped the configured host workspace root");
  await mkdir(fixtureHostPath, { recursive: false });
  await writeFile(
    join(fixtureHostPath, "README.md"),
    "# Disposable AgentWeave Codex smoke fixture\n",
  );
  await writeFile(
    join(fixtureHostPath, "verify.mjs"),
    `import { readFile } from "node:fs/promises";\nconst actual = await readFile("SMOKE.md", "utf8");\nif (actual !== ${JSON.stringify(expected)}) throw new Error("SMOKE.md content mismatch");\nconsole.log("SMOKE_OK");\n`,
  );
  await exec("git", ["init", "--quiet"], { cwd: fixtureHostPath });
  await exec("git", ["add", "README.md", "verify.mjs"], {
    cwd: fixtureHostPath,
  });
  await exec(
    "git",
    [
      "-c",
      "user.name=AgentWeave Smoke",
      "-c",
      "user.email=smoke@invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: fixtureHostPath },
  );

  const bridgeHeaders = bridgeToken
    ? { authorization: `Bearer ${bridgeToken}` }
    : {};
  const [apiHealth, bridgeHealth] = await Promise.all([
    fetch(`${apiUrl}/health`),
    fetch(`${bridgeUrl}/v1/codex/health`, { headers: bridgeHeaders }),
  ]);
  if (!apiHealth.ok)
    throw new Error(
      `Control API health check failed: ${await apiHealth.text()}`,
    );
  if (!bridgeHealth.ok)
    throw new Error(
      `Codex bridge health check failed: ${await bridgeHealth.text()}`,
    );

  const created = await api("/api/workstreams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "In this disposable repository, create SMOKE.md containing exactly `AgentWeave Codex smoke OK` followed by one newline. Do not modify other files. PM must decompose the work, PE must review the plan, Coder must make the edit, QA must verify it, and PM must request Human completion approval with evidence.",
      flavor: "software-development",
      tool: "codex",
      model: process.env.AGENTWEAVE_MODEL || "default",
      workspaceRoot: fixtureContainerPath,
    }),
  });
  workstreamId = created.id;
  await api(`/api/workstreams/${workstreamId}/start`, { method: "POST" });

  latest = await waitFor("Human completion review", async () => {
    const snapshot = await api(`/api/workstreams/${workstreamId}/snapshot`);
    if (["failed", "emergency_stopped"].includes(snapshot.workstream.status)) {
      throw new Error(`Workstream stopped in ${snapshot.workstream.status}`);
    }
    return snapshot.workstream.status === "waiting_for_human"
      ? snapshot
      : undefined;
  });

  const workstream = latest.workstream;
  const completedTasks = workstream.tasks.filter(
    (task) => task.status === "done",
  );
  const providerStarts = workstream.events.filter(
    (event) => event.type === "run.started" && event.provider === "codex",
  );
  const evidenceIds = [
    ...new Set(completedTasks.flatMap((task) => task.evidence ?? [])),
  ];
  const humanDecision = workstream.messages.find((message) =>
    message.recipientIds?.includes("human"),
  );
  if (completedTasks.length < 3)
    throw new Error(
      `Expected at least 3 completed role tasks, received ${completedTasks.length}`,
    );
  if (providerStarts.length < 4)
    throw new Error(
      `Expected at least 4 Codex turns, received ${providerStarts.length}`,
    );
  if (!evidenceIds.length)
    throw new Error("No persisted task evidence was reported");
  if (!humanDecision)
    throw new Error("No Human completion-review message was reported");
  if ((await readFile(join(fixtureHostPath, "SMOKE.md"), "utf8")) !== expected)
    throw new Error("Codex edit did not match the expected SMOKE.md content");

  await api(`/api/workstreams/${workstreamId}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decision: "complete",
      reason:
        "Automated Human boundary for the explicitly authorized disposable smoke fixture",
    }),
  });
  latest = await waitFor("persisted completion", async () => {
    const snapshot = await api(`/api/workstreams/${workstreamId}/snapshot`);
    return snapshot.workstream.status === "completed" ? snapshot : undefined;
  });

  const report = {
    passed: true,
    workstreamId,
    fixtureHostPath,
    fixtureContainerPath,
    completedTasks: completedTasks.length,
    providerTurns: providerStarts.length,
    evidenceIds,
    finalStatus: latest.workstream.status,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Real Codex Workstream smoke passed.\nWorkstream: ${workstreamId}\nFixture: ${fixtureHostPath}\nReport: ${reportPath}`,
  );
} catch (error) {
  const report = {
    passed: false,
    workstreamId,
    fixtureHostPath,
    fixtureContainerPath,
    error: error instanceof Error ? error.message : String(error),
    lastSnapshot: latest,
    recordedAt: new Date().toISOString(),
  };
  await mkdir(fixtureHostPath, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(
    `Real Codex Workstream smoke failed. Fixture and report were preserved for diagnosis.\nReport: ${reportPath}\nInspect: docker compose logs control-api worker`,
  );
  throw error;
}
