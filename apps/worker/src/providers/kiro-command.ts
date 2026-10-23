import type { ProviderRunInput, ProviderSession } from "./types.js";

export type KiroCommandConfig = { command: string; model?: string };
export type KiroCommand = { command: string; args: string[]; stdin: string; options?: { cwd?: string } };

/** Keep Kiro-specific CLI details out of the provider lifecycle. */
export function buildKiroCommand(config: KiroCommandConfig, input: ProviderRunInput, session: ProviderSession, resume: boolean): KiroCommand {
  const model = input.model ?? session.model ?? config.model;
  const args = ["chat", "--no-interactive", "--agent-engine", "v2", "--output-format", "stream-json", "--trust-all-tools",
    ...(resume ? ["--resume-id", session.providerSessionId] : []), ...(model ? ["--model", model] : [])];
  return { command: config.command, args, stdin: input.input, ...(input.workspacePath ? { options: { cwd: input.workspacePath } } : {}) };
}
