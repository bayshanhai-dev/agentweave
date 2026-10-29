export type DutyAgent = { id: string; role: string };

export function resolveDutyAssignee(
  agents: readonly DutyAgent[],
  leadRole: string,
  targetRole?: string,
): { agent: DutyAgent; ownerRole: string } {
  if (targetRole !== undefined) {
    const matches = agents.filter((agent) => agent.role === targetRole);
    if (!matches.length) throw new Error("trigger-target-role-not-found");
    if (matches.length > 1) throw new Error("trigger-target-role-ambiguous");
    return { agent: matches[0]!, ownerRole: matches[0]!.role };
  }

  const agent = agents.find((candidate) => candidate.role === leadRole);
  if (!agent) throw new Error("target-lead-not-found");
  return { agent, ownerRole: agent.role };
}
