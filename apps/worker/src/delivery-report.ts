import type {
  DeliveryHandoff,
  DeliveryRepository,
} from "./delivery/handoff.js";

/**
 * Best-effort delivery-state reports to the Control Plane.
 *
 * `claimed` is reported when the worker picks a message up and starts the
 * recipient's turn; `gated` when the inbox gate signs for a message while
 * the workstream is parked, so no turn will run. Reporting must never break
 * message processing: failures are swallowed and the next state transition
 * (or the operator) reconciles.
 */
export async function reportDelivery(
  apiUrl: string,
  workstreamId: string,
  messageId: string,
  recipientId: string,
  status: "claimed" | "gated",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(
      `${apiUrl}/api/workstreams/${encodeURIComponent(workstreamId)}/messages/${encodeURIComponent(messageId)}/delivery`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientId, status }),
      },
    );
  } catch {
    /* Control Plane may be restarting; delivery state is advisory. */
  }
}

export type DeliveryCiStatus = "ci_pending" | "ci_passed" | "ci_failed";

export type DeliverySucceededReport = {
  event: "delivery.succeeded";
  schema: "delivery-path/v1";
  task_id: string;
  workstream_id: string;
  run_id: string;
  idempotency_key: string;
  repository: DeliveryRepository;
  branch: string;
  base_ref: string;
  commit: string;
  changed_files: string[];
  pr_url: string;
  ci_status: DeliveryCiStatus;
  credential_ref: { store: string; name: string };
  evidence: string;
};

export type DeliveryBlockedReport = {
  event: "delivery.blocked";
  schema: "delivery-path/v1";
  task_id: string;
  workstream_id: string;
  run_id: string;
  status: "BLOCKED";
  reason: string;
  attempted_action: string;
  evidence: string;
  next_owner: "worker" | "human_deputy" | "Reviewer" | "Maintainer";
  next_action: string;
  blocked_since: string;
};

export type DeliveryOutcomeReport =
  DeliverySucceededReport | DeliveryBlockedReport;

export type DeputyDeliveryRoute = {
  recipient: "human_deputy";
  handoff: DeliveryHandoff;
};

export interface DeliveryReportPublisher {
  publish(
    workstreamId: string,
    report: DeliveryOutcomeReport,
    route?: DeputyDeliveryRoute,
  ): Promise<void>;
}

/**
 * Delivery outcomes are not advisory, so this path deliberately fails when
 * the Control Plane does not durably accept the report. This differs from the
 * best-effort claimed/gated update above.
 */
export class HttpDeliveryReportPublisher implements DeliveryReportPublisher {
  constructor(
    private readonly apiUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async publish(
    workstreamId: string,
    report: DeliveryOutcomeReport,
    route?: DeputyDeliveryRoute,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.apiUrl}/api/workstreams/${encodeURIComponent(workstreamId)}/delivery-reports`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report, ...(route ? { route } : {}) }),
      },
    );
    if (!response.ok) {
      throw new Error(`delivery_report_publish_failed:${response.status}`);
    }
  }
}
