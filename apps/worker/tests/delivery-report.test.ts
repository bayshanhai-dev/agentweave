import { describe, expect, it, vi } from "vitest";
import {
  HttpDeliveryReportPublisher,
  reportDelivery,
} from "../src/delivery-report.js";

describe("reportDelivery", () => {
  it("posts the delivery state for the recipient to the control plane", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await reportDelivery(
      "http://control-api:3000",
      "ws 1",
      "msg/2",
      "agent-1",
      "claimed",
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://control-api:3000/api/workstreams/ws%201/messages/msg%2F2/delivery",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      recipientId: "agent-1",
      status: "claimed",
    });
  });

  it("swallows network failures so message processing never breaks", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(
      reportDelivery(
        "http://control-api:3000",
        "ws",
        "m",
        "agent-1",
        "gated",
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("HttpDeliveryReportPublisher", () => {
  it("publishes terminal delivery evidence through the workstream report path", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
    const publisher = new HttpDeliveryReportPublisher(
      "http://control-api:3000",
      fetchImpl as unknown as typeof fetch,
    );
    const report = {
      event: "delivery.blocked" as const,
      schema: "delivery-path/v1" as const,
      task_id: "issue-146",
      workstream_id: "owner-team",
      run_id: "run-1",
      status: "BLOCKED" as const,
      reason: "credential_unprovisioned",
      attempted_action: "resolve_credential",
      evidence: "delivery-receipt:key",
      next_owner: "human_deputy" as const,
      next_action: "Provision the credential.",
      blocked_since: "2026-11-04T12:00:00.000Z",
    };
    const handoff = {
      schema: "delivery-path/v1" as const,
      task_id: "issue-146",
      workstream_id: "owner-team",
      run_id: "run-1",
      repository: { host: "github.com", owner: "owner", name: "repo" },
      base_ref: "main",
      branch: "codex/issue-146",
      commit_summary: "Deliver issue 146",
      changed_files: ["change.txt"],
      requested_actor: "worker" as const,
      credential_ref: {
        store: "box-secret-store",
        name: "github/owner/repo/push",
        value: null,
      },
      idempotency_key: `sha256:${"a".repeat(64)}`,
      status: "ready_for_delivery" as const,
      created_at: "2026-11-04T11:00:00.000Z",
      expires_at: "2026-11-04T13:00:00.000Z",
      agent_boundary: {
        workspace: "workspace-write" as const,
        git: "read-only" as const,
      },
    };

    await publisher.publish("owner-team", report, {
      recipient: "human_deputy",
      handoff,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://control-api:3000/api/workstreams/owner-team/delivery-reports",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      report,
      route: { recipient: "human_deputy", handoff },
    });
  });

  it("does not swallow a failed terminal report publication", async () => {
    const publisher = new HttpDeliveryReportPublisher(
      "http://control-api:3000",
      vi.fn(
        async () => new Response("{}", { status: 503 }),
      ) as unknown as typeof fetch,
    );
    await expect(
      publisher.publish("owner-team", {
        event: "delivery.blocked",
        schema: "delivery-path/v1",
        task_id: "issue-146",
        workstream_id: "owner-team",
        run_id: "run-1",
        status: "BLOCKED",
        reason: "push_failed",
        attempted_action: "push_branch",
        evidence: "delivery-receipt:key",
        next_owner: "worker",
        next_action: "Retry.",
        blocked_since: "2026-11-04T12:00:00.000Z",
      }),
    ).rejects.toThrow("delivery_report_publish_failed:503");
  });
});
