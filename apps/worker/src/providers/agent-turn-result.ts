import { agentTurnResultSchema, type AgentTurnResult } from "@agentweave/protocol";

export function parseAgentTurnResult(text: string): AgentTurnResult {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? text.trim();
  try {
    return agentTurnResultSchema.parse(JSON.parse(candidate));
  } catch (error) {
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
}
