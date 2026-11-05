type RecordValue = Record<string, unknown>;

export type DeliveryReportSubmission = {
  report: RecordValue & {
    event: "delivery.succeeded" | "delivery.blocked";
    workstream_id: string;
    task_id: string;
    run_id: string;
  };
  route?: {
    recipient: "human_deputy";
    handoff: RecordValue;
  };
};

const SUCCEEDED_KEYS = [
  "event",
  "schema",
  "task_id",
  "workstream_id",
  "run_id",
  "idempotency_key",
  "repository",
  "branch",
  "base_ref",
  "commit",
  "changed_files",
  "pr_url",
  "ci_status",
  "credential_ref",
  "evidence",
];

const BLOCKED_KEYS = [
  "event",
  "schema",
  "task_id",
  "workstream_id",
  "run_id",
  "status",
  "reason",
  "attempted_action",
  "evidence",
  "next_owner",
  "next_action",
  "blocked_since",
];

const HANDOFF_KEYS = [
  "schema",
  "task_id",
  "workstream_id",
  "run_id",
  "repository",
  "base_ref",
  "branch",
  "commit_summary",
  "changed_files",
  "requested_actor",
  "credential_ref",
  "idempotency_key",
  "status",
  "created_at",
  "expires_at",
  "agent_boundary",
];

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function nonEmptyStrings(value: RecordValue, keys: string[]): boolean {
  return keys.every(
    (key) =>
      typeof value[key] === "string" && String(value[key]).trim().length > 0,
  );
}

function validCredentialRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["store", "name"]) &&
    nonEmptyStrings(value, ["store", "name"])
  );
}

function validHandoffCredentialRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["store", "name", "value"]) &&
    nonEmptyStrings(value, ["store", "name"]) &&
    value.value === null
  );
}

function validDeputyHandoff(value: unknown): value is RecordValue {
  if (!isRecord(value) || !hasExactKeys(value, HANDOFF_KEYS)) return false;
  if (
    value.schema !== "delivery-path/v1" ||
    value.status !== "ready_for_delivery" ||
    (value.requested_actor !== "worker" &&
      value.requested_actor !== "human_deputy") ||
    !nonEmptyStrings(value, [
      "task_id",
      "workstream_id",
      "run_id",
      "base_ref",
      "branch",
      "commit_summary",
      "idempotency_key",
      "created_at",
      "expires_at",
    ]) ||
    !Array.isArray(value.changed_files) ||
    value.changed_files.length === 0 ||
    value.changed_files.some((path) => typeof path !== "string" || !path) ||
    !validHandoffCredentialRef(value.credential_ref) ||
    !isRecord(value.repository) ||
    !hasExactKeys(value.repository, ["host", "owner", "name"]) ||
    !nonEmptyStrings(value.repository, ["host", "owner", "name"]) ||
    !isRecord(value.agent_boundary) ||
    !hasExactKeys(value.agent_boundary, ["workspace", "git"]) ||
    value.agent_boundary.workspace !== "workspace-write" ||
    value.agent_boundary.git !== "read-only"
  ) {
    return false;
  }
  return true;
}

export function parseDeliveryReportSubmission(
  input: unknown,
  workstreamId: string,
): DeliveryReportSubmission {
  if (
    !isRecord(input) ||
    !hasExactKeys(
      input,
      input.route === undefined ? ["report"] : ["report", "route"],
    )
  ) {
    throw new Error("invalid_delivery_report_envelope");
  }
  if (!isRecord(input.report)) throw new Error("invalid_delivery_report");
  const report = input.report;
  if (
    report.schema !== "delivery-path/v1" ||
    report.workstream_id !== workstreamId
  ) {
    throw new Error("invalid_delivery_report_identity");
  }
  if (
    !nonEmptyStrings(report, ["task_id", "workstream_id", "run_id", "evidence"])
  ) {
    throw new Error("invalid_delivery_report_identity");
  }

  if (report.event === "delivery.succeeded") {
    if (
      !hasExactKeys(report, SUCCEEDED_KEYS) ||
      !nonEmptyStrings(report, [
        "idempotency_key",
        "branch",
        "base_ref",
        "commit",
        "pr_url",
      ]) ||
      !isRecord(report.repository) ||
      !hasExactKeys(report.repository, ["host", "owner", "name"]) ||
      !nonEmptyStrings(report.repository, ["host", "owner", "name"]) ||
      !Array.isArray(report.changed_files) ||
      report.changed_files.length === 0 ||
      report.changed_files.some((path) => typeof path !== "string" || !path) ||
      !["ci_pending", "ci_passed", "ci_failed"].includes(
        String(report.ci_status),
      ) ||
      !validCredentialRef(report.credential_ref) ||
      input.route !== undefined
    ) {
      throw new Error("invalid_delivery_succeeded_report");
    }
  } else if (report.event === "delivery.blocked") {
    if (
      !hasExactKeys(report, BLOCKED_KEYS) ||
      report.status !== "BLOCKED" ||
      !nonEmptyStrings(report, [
        "reason",
        "attempted_action",
        "next_owner",
        "next_action",
        "blocked_since",
      ]) ||
      !["worker", "human_deputy", "Reviewer", "Maintainer"].includes(
        String(report.next_owner),
      )
    ) {
      throw new Error("invalid_delivery_blocked_report");
    }
  } else {
    throw new Error("invalid_delivery_report_event");
  }

  let route: DeliveryReportSubmission["route"];
  if (input.route !== undefined) {
    if (
      report.event !== "delivery.blocked" ||
      report.reason !== "credential_unprovisioned" ||
      !isRecord(input.route) ||
      !hasExactKeys(input.route, ["recipient", "handoff"]) ||
      input.route.recipient !== "human_deputy" ||
      !validDeputyHandoff(input.route.handoff) ||
      input.route.handoff.task_id !== report.task_id ||
      input.route.handoff.workstream_id !== report.workstream_id ||
      input.route.handoff.run_id !== report.run_id
    ) {
      throw new Error("invalid_deputy_route");
    }
    route = { recipient: "human_deputy", handoff: input.route.handoff };
  }

  return {
    report: report as DeliveryReportSubmission["report"],
    ...(route ? { route } : {}),
  };
}
