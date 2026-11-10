type SummaryAgent = { id: string; role: string; status: string; provider?: string; model?: string };
type SummaryTask = { status: string };

export function workstreamSummary(input: {
  id: string;
  goal: string;
  flavor: string;
  status: string;
  provider: unknown;
  roleProviders: unknown;
  agents: readonly SummaryAgent[];
  tasks: readonly SummaryTask[];
  createdAt?: string;
  updatedAt?: string;
}) {
  const taskCounts: Record<string, number> = {};
  for (const task of input.tasks) taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
  return {
    id: input.id,
    goal: input.goal.slice(0, 240),
    status: input.status,
    flavor: input.flavor,
    provider: input.provider,
    roleProviders: input.roleProviders,
    agents: input.agents.map(({ id, role, status, provider, model }) => ({ id, role, status, ...(provider ? { provider } : {}), ...(model ? { model } : {}) })),
    taskCounts,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}
