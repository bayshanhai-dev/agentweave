export type TerminalMessageStatus = "dismissed";

export function validateDismissal(message: { senderId: string; terminalStatus?: string }, reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (message.senderId !== "human") return { ok: false, error: "only_human_messages_can_be_dismissed" };
  if (message.terminalStatus) return { ok: false, error: "message_already_terminal" };
  if (typeof reason !== "string" || !reason.trim()) return { ok: false, error: "terminal_reason_required" };
  return { ok: true, reason: reason.trim().slice(0, 500) };
}
