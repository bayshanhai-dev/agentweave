import { ClaudeCodeAdapter, type ProcessRunner } from "./claude-code.js";
import { CodexAppServerAdapter, type CodexTransport } from "./codex-app-server.js";
import { MockProviderAdapter } from "./mock.js";
import { CodexStdioTransport } from "./codex-stdio-transport.js";
import type { ProviderAdapter } from "./types.js";

export type ProviderRegistryDependencies = { codexTransport?: CodexTransport; processRunner?: ProcessRunner };
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env, deps: ProviderRegistryDependencies = {}): ProviderAdapter {
  const provider = env.AGENTWEAVE_PROVIDER ?? "mock"; const model = env.AGENTWEAVE_MODEL;
  if (provider === "mock") return new MockProviderAdapter({ delayMs: Number(env.MOCK_PROVIDER_DELAY_MS ?? 0) });
  if (provider === "codex") return new CodexAppServerAdapter(deps.codexTransport ?? new CodexStdioTransport(env.CODEX_APP_SERVER_COMMAND ?? "codex"), { url: env.CODEX_APP_SERVER_URL, command: env.CODEX_APP_SERVER_COMMAND, model });
  if (provider === "claude") return new ClaudeCodeAdapter(deps.processRunner, { command: env.CLAUDE_CODE_COMMAND ?? "claude", model, timeoutMs: Number(env.PROVIDER_REQUEST_TIMEOUT_MS ?? 120000) });
  throw new Error(`Unsupported AGENTWEAVE_PROVIDER: ${provider}`);
}
