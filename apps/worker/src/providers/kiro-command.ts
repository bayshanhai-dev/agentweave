import type { ProviderRunInput, ProviderSession } from "./types.js";

export type KiroCommandConfig = { command: string; model?: string };
export type KiroCommand = { command: string; args: string[]; stdin: string; options?: { cwd?: string } };

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A session id is only safe to pass to `--resume-id` when kiro-cli itself
 * issued it (reported in the stream and persisted by the worker). Ids the
 * adapter mints locally (`local-…`) — and bare UUIDs, which is what the
 * pre-fix adapter minted and stored — were never seen by the CLI; resuming
 * one fails the turn with "Session not found".
 */
export function isCliIssuedSessionId(providerSessionId: string): boolean {
  return providerSessionId.length > 0 && !providerSessionId.startsWith("local-") && !BARE_UUID.test(providerSessionId);
}

/** Keep Kiro-specific CLI details out of the provider lifecycle. */
export function buildKiroCommand(config: KiroCommandConfig, input: ProviderRunInput, session: ProviderSession, resume: boolean): KiroCommand {
  const model = input.model ?? session.model ?? config.model;
  const args = ["chat", "--no-interactive", "--agent-engine", "v2", "--output-format", "stream-json", "--trust-all-tools",
    ...(resume ? ["--resume-id", session.providerSessionId] : []), ...(model ? ["--model", model] : [])];
  return { command: config.command, args, stdin: input.input, ...(input.workspacePath ? { options: { cwd: input.workspacePath } } : {}) };
}
