import { ClaudeCodeAdapter, type ProcessRunner } from "./claude-code.js";
import { CodexAppServerAdapter, type CodexTransport } from "./codex-app-server.js";
import { MockProviderAdapter } from "./mock.js";
import { OllamaAdapter } from "./ollama.js";
import { KiroAdapter, type KiroProcessRunner } from "./kiro.js";
import { CodexStdioTransport } from "./codex-stdio-transport.js";
import { CodexHttpTransport } from "./codex-http-transport.js";
import type { ProviderAdapter } from "./types.js";
import { providerTools, type ProviderTool } from "@agentweave/protocol";

export type ProviderRegistryDependencies = { codexTransport?: CodexTransport; processRunner?: ProcessRunner; kiroProcessRunner?: KiroProcessRunner; ollamaFetchFn?: typeof fetch };
export type ProviderFactories = Record<ProviderTool, () => ProviderAdapter>;

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(
    readonly defaultProviderName: string,
    private readonly factories: Record<string, () => ProviderAdapter>,
    readonly defaultModel?: string,
  ) {}

  get(provider = this.defaultProviderName): ProviderAdapter {
    const existing = this.adapters.get(provider);
    if (existing) return existing;
    const factory = this.factories[provider];
    if (!factory) throw new Error(`Unsupported provider: ${provider}`);
    const adapter = factory();
    this.adapters.set(provider, adapter);
    return adapter;
  }
}

function providerFactories(
  env: NodeJS.ProcessEnv,
  deps: ProviderRegistryDependencies,
  model?: string,
): ProviderFactories {
  return {
    mock: () => new MockProviderAdapter({ delayMs: Number(env.MOCK_PROVIDER_DELAY_MS ?? 0) }),
    codex: () => new CodexAppServerAdapter(deps.codexTransport ?? (env.CODEX_APP_SERVER_URL ? new CodexHttpTransport(env.CODEX_APP_SERVER_URL) : new CodexStdioTransport(env.CODEX_APP_SERVER_COMMAND ?? "codex")), { url: env.CODEX_APP_SERVER_URL, command: env.CODEX_APP_SERVER_COMMAND, model }),
    claude: () => new ClaudeCodeAdapter(deps.processRunner, { command: env.CLAUDE_CODE_COMMAND ?? "claude", model, timeoutMs: Number(env.PROVIDER_REQUEST_TIMEOUT_MS ?? 120000) }),
    ollama: () => new OllamaAdapter({ ...(env.OLLAMA_BASE_URL ? { baseUrl: env.OLLAMA_BASE_URL } : {}), model, fetchFn: deps.ollamaFetchFn }),
    kiro: () => new KiroAdapter(deps.kiroProcessRunner, { command: env.KIRO_CLI_COMMAND ?? "kiro-cli", model, timeoutMs: Number(env.PROVIDER_REQUEST_TIMEOUT_MS ?? 120000) }),
  };
}

export function createProviderRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: ProviderRegistryDependencies = {},
): ProviderAdapterRegistry {
  const defaultProviderName = env.AGENTWEAVE_PROVIDER ?? "mock";
  if (!providerTools.includes(defaultProviderName as ProviderTool)) {
    throw new Error(`Unsupported AGENTWEAVE_PROVIDER: ${defaultProviderName}`);
  }
  return new ProviderAdapterRegistry(defaultProviderName, providerFactories(env, deps), env.AGENTWEAVE_MODEL);
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env, deps: ProviderRegistryDependencies = {}): ProviderAdapter {
  const provider = env.AGENTWEAVE_PROVIDER ?? "mock";
  if (!providerTools.includes(provider as ProviderTool)) throw new Error(`Unsupported AGENTWEAVE_PROVIDER: ${provider}`);
  return providerFactories(env, deps, env.AGENTWEAVE_MODEL)[provider as ProviderTool]();
}
