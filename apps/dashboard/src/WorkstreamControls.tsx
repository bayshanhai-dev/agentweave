import { useState } from "react";

type Props = { api: string; workstreamId: string; status: string; onStatus: (status: string) => void };
const commands = [{ key: "pause", label: "Pause" }, { key: "resume", label: "Resume" }, { key: "complete", label: "Complete" }, { key: "emergency-stop", label: "Emergency stop" }];

export function WorkstreamControls({ api, workstreamId, status, onStatus }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  async function command(key: string) { setBusy(key); const response = await fetch(`${api}/api/workstreams/${workstreamId}/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: `${key}-${Date.now()}` }) }); const result = await response.json() as { status?: string; error?: string }; if (response.ok && result.status) onStatus(result.status); setBusy(null); }
  async function approval(decision: "complete" | "reject") { setBusy(`approval-${decision}`); const response = await fetch(`${api}/api/workstreams/${workstreamId}/approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: `approval-${decision}-${Date.now()}`, decision }) }); const result = await response.json() as { status?: string }; if (response.ok && result.status) onStatus(result.status); setBusy(null); }
  const waiting = status === "waiting_for_human";
  return <div className="workstream-controls"><span className="controls-label">Workstream controls</span><div className="control-actions">{commands.map((item) => <button key={item.key} className={item.key === "emergency-stop" ? "danger" : "secondary"} disabled={busy !== null || (item.key === "pause" && status === "paused") || (item.key === "resume" && status !== "paused")} onClick={() => void command(item.key)}>{busy === item.key ? "Working…" : item.label}</button>)}{waiting && <><button className="approve" disabled={busy !== null} onClick={() => void approval("complete")}>{busy === "approval-complete" ? "Working…" : "Approve & complete"}</button><button className="secondary" disabled={busy !== null} onClick={() => void approval("reject")}>Reject</button></>}</div></div>;
}
