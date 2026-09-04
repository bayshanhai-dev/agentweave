const bridgeUrl = process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:3010";
const workspacePath = process.env.CODEX_SMOKE_WORKSPACE?.trim();
const bridgeToken = process.env.CODEX_BRIDGE_TOKEN?.trim();

if (!workspacePath) {
  throw new Error(
    "CODEX_SMOKE_WORKSPACE is required and must name a narrow, allowed host workspace.",
  );
}

const headers = {
  "content-type": "application/json",
  ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}),
};

const health = await fetch(`${bridgeUrl}/v1/codex/health`, { headers });
if (!health.ok) {
  throw new Error(`Codex bridge health check failed: ${await health.text()}`);
}

const response = await fetch(`${bridgeUrl}/v1/codex/execute`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    workspacePath,
    ...(process.env.AGENTWEAVE_MODEL
      ? { model: process.env.AGENTWEAVE_MODEL }
      : {}),
    prompt:
      "[CLARIFICATION_REQUEST] Read-only AgentWeave provider smoke test. Do not inspect or modify files. Reply exactly: [CLARIFICATION_REQUEST] CODEX_SMOKE_OK",
  }),
});

if (!response.ok) {
  throw new Error(`Codex smoke request failed: ${await response.text()}`);
}

const result = await response.json();
if (result.exitCode !== 0 || !String(result.text).includes("CODEX_SMOKE_OK")) {
  throw new Error(`Unexpected Codex smoke result: ${JSON.stringify(result)}`);
}

console.log("Codex provider smoke test passed.");
