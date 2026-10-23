import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { providerError } from "./errors.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderError,
  ProviderRunEvent,
  ProviderRunInput,
  ProviderRunResult,
  ProviderSession,
  ProviderUsage,
  SessionCheckpoint,
} from "./types.js";

const SYSTEM_MESSAGE = "You are an agent working inside a workspace directory. Use the provided tools to inspect files, modify files, and run commands. All tool paths are relative to the workspace root. When the task is fully complete, send your final report as a plain text reply (including any structured JSON the instructions ask for) and do not call any more tools.";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List the entries in a workspace directory without recursing.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path relative to the workspace root. Defaults to '.'." } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the workspace root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write UTF-8 text to a file in the workspace, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          content: { type: "string", description: "Complete file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace root and return its exit code and combined output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to run." } },
        required: ["command"],
      },
    },
  },
] as const;

type OllamaToolCall = {
  id?: string;
  function: { name: string; arguments: unknown };
};

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
};

type OllamaChunk = {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
};

export type OllamaAdapterOptions = {
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  maxToolIterations?: number;
  commandTimeoutMs?: number;
  maxOutputChars?: number;
};

class OllamaFailure extends Error {
  constructor(readonly detail: ProviderError) {
    super(detail.message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield JSON.parse(trimmed) as OllamaChunk;
      }
    }
    buffer += decoder.decode();
    const trimmed = buffer.trim();
    if (trimmed) yield JSON.parse(trimmed) as OllamaChunk;
  } finally {
    reader.releaseLock();
  }
}

export class OllamaAdapter implements ProviderAdapter {
  readonly name = "ollama";
  readonly capabilities: ProviderCapabilities = { streaming: true, toolCalls: true, resume: true, cancellation: true };

  private readonly baseUrl: string;
  private readonly model?: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxToolIterations: number;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly histories = new Map<string, OllamaMessage[]>();
  private readonly activeTurns = new Map<string, AbortController>();

  constructor(options: OllamaAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.maxToolIterations = options.maxToolIterations ?? 32;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxOutputChars = options.maxOutputChars ?? 20_000;
  }

  async createSession(input: { model?: string; workspacePath?: string; correlationId?: string } = {}): Promise<ProviderSession> {
    const now = new Date().toISOString();
    const model = input.model ?? this.model;
    const session: ProviderSession = {
      provider: this.name,
      ...(model ? { model } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      providerSessionId: `ollama-${crypto.randomUUID()}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.histories.set(session.providerSessionId, []);
    return session;
  }

  async resumeSession(session: ProviderSession): Promise<ProviderSession> {
    return { ...session, status: "active", updatedAt: new Date().toISOString() };
  }

  async checkpoint(session: ProviderSession): Promise<SessionCheckpoint> {
    return {
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      ...(session.providerTurnId ? { providerTurnId: session.providerTurnId } : {}),
      sequence: 0,
      state: { messages: this.histories.get(session.providerSessionId) ?? [] },
      createdAt: new Date().toISOString(),
    };
  }

  async *run(input: ProviderRunInput): AsyncGenerator<ProviderRunEvent, ProviderRunResult> {
    const session = input.session ?? await this.createSession({
      ...(input.model ? { model: input.model } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    const turnId = `${session.providerSessionId}:turn:${input.idempotencyKey ?? crypto.randomUUID()}`;
    const correlation = input.correlationId ? { correlationId: input.correlationId } : {};
    const controller = new AbortController();
    this.activeTurns.set(turnId, controller);
    yield { type: "turn.started", turnId, ...correlation };

    const messages: OllamaMessage[] = [
      ...(this.histories.get(session.providerSessionId) ?? []),
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: input.input },
    ];
    const root = resolve(input.workspacePath ?? session.workspacePath ?? process.cwd());
    let finalText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let hasUsage = false;

    try {
      for (let round = 0; round < this.maxToolIterations; round += 1) {
        const response = await this.request({
          model: input.model ?? session.model ?? this.model,
          messages,
          tools: TOOLS,
          stream: true,
        }, controller, input.correlationId);

        if (!response.body) {
          throw new OllamaFailure(providerError("Ollama returned an empty response body", "provider", "retryable", {
            code: "OLLAMA_EMPTY_RESPONSE",
            provider: this.name,
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }));
        }

        let roundText = "";
        const roundToolCalls: OllamaToolCall[] = [];
        try {
          for await (const chunk of parseNdjson(response.body)) {
            const content = chunk.message?.content;
            if (content) {
              roundText += content;
              yield { type: "turn.delta", turnId, text: content, ...correlation };
            }
            if (chunk.message?.tool_calls) roundToolCalls.push(...chunk.message.tool_calls);
            if (chunk.done) {
              if (typeof chunk.prompt_eval_count === "number") {
                inputTokens += chunk.prompt_eval_count;
                hasUsage = true;
              }
              if (typeof chunk.eval_count === "number") {
                outputTokens += chunk.eval_count;
                hasUsage = true;
              }
            }
          }
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Ollama turn cancelled");
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw new OllamaFailure(providerError(errorMessage(error), "transport", "retryable", {
            code: "OLLAMA_TRANSPORT",
            provider: this.name,
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }));
        }

        finalText = roundText;
        if (roundToolCalls.length === 0) {
          messages.push({ role: "assistant", content: roundText });
          break;
        }

        const toolCalls = roundToolCalls.map((call, index) => ({
          ...call,
          id: call.id ?? `${turnId}:tool:${round}:${index}`,
        }));
        messages.push({ role: "assistant", content: roundText, tool_calls: toolCalls });
        for (const call of toolCalls) {
          const toolName = call.function?.name ?? "";
          const toolCallId = call.id;
          yield { type: "tool.started", turnId, toolName, toolCallId, ...correlation };
          const output = await this.executeTool(toolName, call.function?.arguments, root);
          const truncatedOutput = this.truncate(output);
          yield { type: "tool.completed", turnId, toolName, toolCallId, output: truncatedOutput, ...correlation };
          messages.push({ role: "tool", content: truncatedOutput });
        }
      }

      this.histories.set(session.providerSessionId, messages);
      if (!finalText.trim()) {
        const error = providerError("Ollama completed without text output", "provider", "retryable", {
          code: "OLLAMA_EMPTY_OUTPUT",
          provider: this.name,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        });
        yield { type: "turn.failed", turnId, error, ...correlation };
        throw new OllamaFailure(error);
      }

      const usage: ProviderUsage | undefined = hasUsage ? {
        source: "provider",
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      } : undefined;
      if (usage) yield { type: "usage.updated", turnId, usage, ...correlation };
      yield { type: "turn.completed", turnId, text: finalText, ...(usage ? { usage } : {}), ...correlation };
      return {
        turnId,
        text: finalText,
        session: { ...session, providerTurnId: turnId, status: "completed", updatedAt: new Date().toISOString() },
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const cancelled = providerError("Ollama turn cancelled", "cancelled", "non-retryable", {
          code: "OLLAMA_CANCELLED",
          provider: this.name,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        });
        yield { type: "turn.cancelled", turnId, ...correlation };
        throw Object.assign(new Error(cancelled.message), cancelled);
      }
      const failure = error instanceof OllamaFailure ? error.detail : providerError(errorMessage(error), "provider", "retryable", {
        code: "OLLAMA_ERROR",
        provider: this.name,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      });
      if (failure.code !== "OLLAMA_EMPTY_OUTPUT") yield { type: "turn.failed", turnId, error: failure, ...correlation };
      throw new Error(failure.message);
    } finally {
      this.activeTurns.delete(turnId);
    }
  }

  async *cancel(_session: ProviderSession, turnId: string, correlationId?: string): AsyncGenerator<ProviderRunEvent> {
    this.activeTurns.get(turnId)?.abort();
    yield { type: "turn.cancelled", turnId, ...(correlationId ? { correlationId } : {}) };
  }

  private async request(body: Record<string, unknown>, controller: AbortController, correlationId?: string): Promise<Response> {
    let response: Response;
    try {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Ollama turn cancelled");
      response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Ollama turn cancelled");
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new OllamaFailure(providerError(errorMessage(error), "transport", "retryable", {
        code: "OLLAMA_TRANSPORT",
        provider: this.name,
        ...(correlationId ? { correlationId } : {}),
      }));
    }

    if (response.ok) return response;
    let responseBody = "";
    try {
      responseBody = await response.text();
    } catch {
      // The HTTP status is enough to classify the failure when the body cannot be read.
    }
    const message = responseBody.trim() || `Ollama request failed with HTTP ${response.status}`;
    if (response.status === 404 && /not\s+found|model/i.test(responseBody)) {
      throw new OllamaFailure(providerError(message, "configuration", "user-action-required", {
        code: "OLLAMA_MODEL_NOT_FOUND",
        provider: this.name,
        statusCode: 404,
        ...(correlationId ? { correlationId } : {}),
      }));
    }
    throw new OllamaFailure(providerError(message, "provider", "retryable", {
      code: `OLLAMA_HTTP_${response.status}`,
      provider: this.name,
      statusCode: response.status,
      ...(correlationId ? { correlationId } : {}),
    }));
  }

  private async executeTool(name: string, rawArguments: unknown, root: string): Promise<string> {
    const args = this.parseArguments(rawArguments);
    try {
      if (name === "list_files") {
        const requestedPath = typeof args.path === "string" ? args.path : ".";
        const target = this.confinedPath(root, requestedPath);
        if (!target) return "Error: path escapes the workspace";
        const entries = await readdir(target, { withFileTypes: true });
        return entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort().join("\n");
      }
      if (name === "read_file") {
        if (typeof args.path !== "string") return "Error: path is required";
        const target = this.confinedPath(root, args.path);
        if (!target) return "Error: path escapes the workspace";
        return this.truncate(await readFile(target, "utf8"));
      }
      if (name === "write_file") {
        if (typeof args.path !== "string") return "Error: path is required";
        if (typeof args.content !== "string") return "Error: content is required";
        const target = this.confinedPath(root, args.path);
        if (!target) return "Error: path escapes the workspace";
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, "utf8");
        return `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`;
      }
      if (name === "run_command") {
        if (typeof args.command !== "string") return "Error: command is required";
        return await this.runCommand(args.command, root);
      }
      return `Error: unknown tool ${name}`;
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
  }

  private parseArguments(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private confinedPath(root: string, requestedPath: string): string | undefined {
    const target = resolve(root, requestedPath);
    return target === root || target.startsWith(`${root}${sep}`) ? target : undefined;
  }

  private runCommand(command: string, root: string): Promise<string> {
    return new Promise((complete) => {
      exec(command, {
        cwd: root,
        shell: "/bin/sh",
        timeout: this.commandTimeoutMs,
        maxBuffer: Math.max(10 * 1024 * 1024, this.maxOutputChars * 4),
      }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        complete(this.truncate(`exit code: ${code}\n${stdout}${stderr}`));
      });
    });
  }

  private truncate(output: string): string {
    if (output.length <= this.maxOutputChars) return output;
    return `${output.slice(0, Math.max(0, this.maxOutputChars))}\n[truncated]`;
  }
}
