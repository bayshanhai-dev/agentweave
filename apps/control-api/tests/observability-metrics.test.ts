import { describe, expect, it } from "vitest";
import { renderPrometheus, type MetricSample } from "../src/observability-metrics.js";

describe("observability metrics exposition", () => {
  it("renders exact HELP/TYPE metadata and finite numeric samples", () => {
    const samples: MetricSample[] = [
      { name: "agentweave_turns_total", labels: { outcome: "success", workstream_id: "ws-1", role: "lead", provider: "mock" }, value: 2 },
      { name: "agentweave_workstream_silence_seconds", labels: { workstream_id: "ws-1" }, value: 12 },
      { name: "agentweave_stuck_delivered_messages_total", value: 0 },
      { name: "agentweave_duty_fulfillment_ratio", labels: { trigger_id: "trigger-1" }, value: 0.9 },
      { name: "agentweave_duty_runs_total", labels: { trigger_id: "trigger-1", outcome: "fulfilled" }, value: 1 },
      { name: "agentweave_outbox_backlog", value: 0 },
      { name: "agentweave_outbox_delivered_total", value: 3 },
      { name: "agentweave_outbox_retry_total", value: 1 },
      { name: "agentweave_outbox_dead_letter_total", value: 0 },
      { name: "agentweave_replay_gap_total", value: 0 },
      { name: "agentweave_redelivery_total", value: 0 },
    ];
    const exposition = renderPrometheus(samples);
    for (const name of [...new Set(samples.map((sample) => sample.name))]) {
      expect(exposition).toContain(`# HELP ${name} `);
      expect(exposition).toContain(`# TYPE ${name} `);
    }
    expect(exposition).not.toMatch(/NaN|Infinity|-Infinity/);
    expect(exposition).toContain("# TYPE agentweave_stuck_delivered_messages_total gauge");
    expect(exposition).toContain("# TYPE agentweave_outbox_delivered_total counter");
  });

  it("escapes labels and converts non-finite samples to zero", () => {
    const exposition = renderPrometheus([
      { name: "agentweave_workstream_silence_seconds", labels: { workstream_id: 'ws"\\\n1' }, value: Number.NaN },
    ]);
    expect(exposition).toContain('agentweave_workstream_silence_seconds{workstream_id="ws\\"\\\\\\n1"} 0');
  });
});
