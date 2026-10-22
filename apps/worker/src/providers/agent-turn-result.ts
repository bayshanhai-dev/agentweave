import { agentTurnResultSchema, type AgentTurnResult } from "@agentweave/protocol";

function firstBalancedObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

export function parseAgentTurnResult(text: string): AgentTurnResult {
  // Try markdown code fence first, then the whole text, then JSON embedded in prose.
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1];
  if (fenced) candidates.push(fenced);
  candidates.push(text.trim());
  const balanced = firstBalancedObject(text);
  if (balanced && !candidates.includes(balanced)) candidates.push(balanced);
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
