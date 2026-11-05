import { describe, expect, it } from "vitest";
import { parseDeliveryReportSubmission } from "../src/delivery-report-ingestion.js";

const blockedReport = {
  event: "delivery.blocked",
  schema: "delivery-path/v1",
  task_id: "issue-146",
  workstream_id: "owner-team",
  run_id: "run-1",
  status: "BLOCKED",
  reason: "credential_unprovisioned",
  attempted_action: "resolve_credential",
  evidence: "delivery-receipt:key",
  next_owner: "human_deputy",
  next_action: "Provision the credential.",
  blocked_since: "2026-11-04T12:00:00.000Z",
};

const handoff = {
  schema: "delivery-path/v1",
  task_id: "issue-146",
  workstream_id: "owner-team",
  run_id: "run-1",
  repository: { host: "github.com", owner: "owner", name: "repo" },
  base_ref: "main",
  branch: "codex/issue-146",
  commit_summary: "Deliver issue 146",
  changed_files: ["change.txt"],
  requested_actor: "worker",
  credential_ref: {
    store: "box-secret-store",
    name: "github/owner/repo/push",
    value: null,
  },
  idempotency_key: `sha256:${"a".repeat(64)}`,
  status: "ready_for_delivery",
  created_at: "2026-11-04T11:00:00.000Z",
  expires_at: "2026-11-04T13:00:00.000Z",
  agent_boundary: { workspace: "workspace-write", git: "read-only" },
};

describe("delivery report ingestion", () => {
  it("accepts a credential-unprovisioned report with a deputy route", () => {
    expect(
      parseDeliveryReportSubmission(
        {
          report: blockedReport,
          route: { recipient: "human_deputy", handoff },
        },
        "owner-team",
      ),
    ).toEqual({
      report: blockedReport,
      route: { recipient: "human_deputy", handoff },
    });
  });

  it("rejects secret values and extra report fields", () => {
    expect(() =>
      parseDeliveryReportSubmission(
        {
          report: { ...blockedReport, credential: "secret" },
        },
        "owner-team",
      ),
    ).toThrow("invalid_delivery_blocked_report");
    expect(() =>
      parseDeliveryReportSubmission(
        {
          report: blockedReport,
          route: {
            recipient: "human_deputy",
            handoff: {
              ...handoff,
              credential_ref: { ...handoff.credential_ref, value: "secret" },
            },
          },
        },
        "owner-team",
      ),
    ).toThrow("invalid_deputy_route");
  });
});
