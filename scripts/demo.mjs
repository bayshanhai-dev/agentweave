const apiUrl = process.env.CONTROL_API_URL ?? "http://localhost:3000";
const goal = process.env.AGENTWEAVE_DEMO_GOAL ?? "Build a small, accessible markdown note editor with a clear README and passing tests.";

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) return;
    } catch {
      // Docker is still starting; retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Control API did not become healthy within 60 seconds at ${apiUrl}. Run \"make logs\" for details.`);
}

await waitForApi();
const created = await fetch(`${apiUrl}/api/workstreams`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    goal,
    flavor: "software-development",
    tool: process.env.AGENTWEAVE_PROVIDER ?? "mock",
    model: process.env.AGENTWEAVE_MODEL || "deterministic",
    // The repository-local workspace mount always exists in the Docker
    // Worker. A user can select a project subdirectory after the smoke test.
    workspaceRoot: "/workspaces",
  }),
});
if (!created.ok) throw new Error(`Unable to create demo: ${await created.text()}`);
const workstream = await created.json();
const started = await fetch(`${apiUrl}/api/workstreams/${workstream.id}/start`, { method: "POST" });
if (!started.ok) throw new Error(`Unable to start demo: ${await started.text()}`);

console.log(`Demo workstream started: ${workstream.id}`);
console.log("Open http://localhost:5173 and select it from the Workstreams menu.");
