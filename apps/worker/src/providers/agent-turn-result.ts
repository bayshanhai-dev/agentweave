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

function normalizeCandidate(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const insights = (candidate as Record<string, unknown>).insights;
  if (!Array.isArray(insights)) return candidate;
  for (const insight of insights) {
    if (!insight || typeof insight !== "object" || Array.isArray(insight)) continue;
    const fields = insight as Record<string, unknown>;
    if (typeof fields.content !== "string" && typeof fields.summary === "string") {
      fields.content = fields.summary;
    }
  }
  return candidate;
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
  for (const candidate of candidates) {
    try {
      return agentTurnResultSchema.parse(normalizeCandidate(JSON.parse(candidate)));
    } catch {}
  }
  // Invalid structured output becomes a summary-only result. Downstream decomposition
  // gates reject and re-prompt it, while collaboration can use its prose fallback.
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
