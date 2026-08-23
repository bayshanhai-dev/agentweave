type Task = { title: string; status: string; evidence: string[]; acceptanceCriteria: string[] };
type Agent = { role: string; authority: string; status: string };
type Event = { type?: string; message?: string; content?: string };
type Props = { status: string; tasks: Task[]; agents: Agent[]; messages: Event[]; events: Event[] };

export function SummaryReport({ status, tasks, agents, messages, events }: Props) {
  const done = tasks.filter((task) => task.status === "done").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const evidence = tasks.reduce((total, task) => total + task.evidence.length, 0);
  const runningAgents = agents.filter((agent) => agent.status === "running");
  const coverage = agents.map((agent) => `${agent.role.toUpperCase()} · ${agent.status}`);
  const latest = events.slice(-1)[0]?.message ?? "No activity recorded yet.";
  const attention = status === "waiting_for_human" ? "Human approval is required before completion." : blocked ? `${blocked} task${blocked === 1 ? " is" : "s are"} blocked.` : "No blocking condition reported.";
  return <div className="summary-report"><div className="section-heading"><h3>Summary Report So Far</h3><span>live workstream snapshot</span></div><p className="summary-narrative">The Workstream is <strong>{status.replaceAll("_", " ")}</strong>. {latest}</p><div className="summary-stats"><div><strong>{done}/{tasks.length}</strong><small>Tasks done</small></div><div><strong>{runningAgents.length}</strong><small>Agents running</small></div><div><strong>{messages.length}</strong><small>Messages</small></div><div><strong>{evidence}</strong><small>Evidence items</small></div></div><div className="summary-details"><div><strong>Current attention</strong><p>{attention}</p></div><div><strong>Agent coverage</strong><p>{coverage.length ? coverage.join("  /  ") : "No agents registered"}</p></div></div></div>;
}
