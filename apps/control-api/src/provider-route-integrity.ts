import type { EffectiveProvider } from "./provider-routing.js";

export function providerRouteMismatch(
  recipient: { role: string } | undefined,
  configured: Record<string, { tool?: string }> | undefined,
  route: EffectiveProvider,
): string | undefined {
  const expected = recipient ? configured?.[recipient.role]?.tool : undefined;
  if (!expected) return undefined;
  if (route.provider !== expected) return `Configured provider override for role ${recipient!.role} was not applied (expected ${expected}, got ${route.provider ?? "worker default"})`;
  return undefined;
}

export function isEmptyProviderTurn(text: string | undefined, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): boolean {
  if (text?.trim()) return false;
  return !usage || (usage.inputTokens ?? 0) === 0 && (usage.outputTokens ?? 0) === 0 && (usage.totalTokens ?? 0) === 0;
}
