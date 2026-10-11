import { agentTurnResultSchema, type AgentTurnResult } from "@agentweave/protocol";

export function parseAgentTurnResult(text: string): AgentTurnResult {
  // Try markdown code fence first, then the whole text, then any JSON object embedded in prose.
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1];
  if (fenced) candidates.push(fenced);
  candidates.push(text.trim());
  // Real LLMs often add prose before/after the JSON ("Here's my proposal: {...}").
  // Find the largest {...} block in the text as a last resort.
  const embedded = text.match(/\{[\s\S]*\}/)?.[0];
  if (embedded && !candidates.includes(embedded)) candidates.push(embedded);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return agentTurnResultSchema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  // Declared JSON must fail validation instead of becoming a successful text turn.
  if (/^\s*(?:\{|```json\b)/.test(text)) throw new Error(`Invalid structured AgentTurnResult: ${String(lastError)}`);
  const summary = text.trim();
  if (!summary) throw new Error("AgentTurnResult is empty or malformed");
  return agentTurnResultSchema.parse({
    summary,
    decision: summary.startsWith("[PROPOSE_COMPLETE]")
      ? { action: "complete", reason: summary.replace(/^\[PROPOSE_COMPLETE\]\s*/, "") || summary }
      : undefined,
    humanBlock: summary.startsWith("[HUMAN_BLOCKED]")
      ? { question: summary.replace(/^\[HUMAN_BLOCKED\]\s*/, ""), context: "Compatibility marker fallback" }
      : undefined,
  });
}
