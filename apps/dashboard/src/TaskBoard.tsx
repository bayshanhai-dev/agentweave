import { useState } from "react";

export type Task = { id: string; title: string; status: string; ownerAgentId?: string; acceptanceCriteria: string[]; dependencies: string[]; evidence: string[] };
type Props = { api: string; workstreamId: string; tasks: Task[]; onChange: (tasks: Task[]) => void };

export function TaskBoard({ api, workstreamId, tasks, onChange }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  async function update(task: Task, status: string) {
    setSaving(task.id);
    const response = await fetch(`${api}/api/workstreams/${workstreamId}/tasks/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, evidence: task.evidence }) });
    if (response.ok) onChange(tasks.map((item) => item.id === task.id ? { ...item, status } : item));
    setSaving(null);
  }
  return <div className="task-board">{tasks.map((task) => <article className="task-card" key={task.id}><div className="task-card-head"><div><p className="kicker">Task</p><h3>{task.title}</h3></div><select value={task.status} disabled={saving === task.id} onChange={(event) => update(task, event.target.value)}><option>ready</option><option>assigned</option><option>running</option><option>review</option><option>blocked</option><option>done</option><option>cancelled</option></select></div><p className="task-meta">Owner · {task.ownerAgentId ?? "Unassigned"}</p><div className="task-section"><strong>Acceptance criteria</strong><ul>{task.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div><div className="task-section"><strong>Dependencies</strong><p>{task.dependencies.length ? task.dependencies.join(", ") : "None"}</p></div><div className="task-section"><strong>Evidence</strong><p>{task.evidence.length ? task.evidence.join(", ") : "No evidence attached yet"}</p></div></article>)}</div>;
}
