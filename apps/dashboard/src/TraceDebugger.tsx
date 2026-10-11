import { useEffect, useMemo, useState } from "react";

type TraceEvent = {
  id: string;
  sequence?: number;
  type: string;
  message: string;
  role?: string;
  agentId?: string;
  taskId?: string;
  correlationId?: string;
  causationId?: string;
  occurredAt: string;
  [key: string]: unknown;
};

type Props = {
  workstreamId: string;
  apiBase: string;
};

/**
 * Debug view for tracing a collaboration round end-to-end.
 * Groups events by correlationId so you can follow proposal → critique → synthesis.
 * Click an event to expand its full JSON payload.
 */
export function TraceDebugger({ workstreamId, apiBase }: Props) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`${apiBase}/api/workstreams/${encodeURIComponent(workstreamId)}/events`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data.events ?? [];
        setEvents(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workstreamId, apiBase]);

  const groups = useMemo(() => {
    const byCorr = new Map<string, TraceEvent[]>();
    for (const e of events) {
      const key = e.correlationId ?? "(no correlation)";
      if (filter && !key.toLowerCase().includes(filter.toLowerCase()) && !e.type.toLowerCase().includes(filter.toLowerCase())) continue;
      const arr = byCorr.get(key) ?? [];
      arr.push(e);
      byCorr.set(key, arr);
    }
    return [...byCorr.entries()].sort((a, b) => (b[1].length - a[1].length));
  }, [events, filter]);

  if (error) return <div className="trace-debugger error">Failed to load events: {error}</div>;

  return (
    <div className="trace-debugger">
      <div className="trace-debugger-header">
        <h3>Trace Debugger</h3>
        <input
          type="text"
          placeholder="Filter by correlationId or event type…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="trace-debugger-filter"
        />
        <span className="trace-debugger-count">{events.length} events, {groups.length} traces</span>
      </div>
      {groups.map(([corrId, evts]) => (
        <div key={corrId} className="trace-group">
          <div className="trace-group-header" title={corrId}>
            <span className="trace-corr-id">{corrId.slice(0, 24)}{corrId.length > 24 ? "…" : ""}</span>
            <span className="trace-event-count">{evts.length} events</span>
          </div>
          <div className="trace-events">
            {evts
              .slice()
              .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
              .map((e) => (
                <div key={e.id} className="trace-event">
                  <button
                    className="trace-event-summary"
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  >
                    <span className="trace-seq">#{e.sequence ?? "?"}</span>
                    <span className="trace-type">{e.type}</span>
                    <span className="trace-msg">{e.message.slice(0, 80)}</span>
                    <span className="trace-time">{new Date(e.occurredAt).toLocaleTimeString()}</span>
                  </button>
                  {expanded === e.id && (
                    <pre className="trace-payload">{JSON.stringify(e, null, 2)}</pre>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}
      {groups.length === 0 && <div className="trace-empty">No events match the filter.</div>}
    </div>
  );
}
