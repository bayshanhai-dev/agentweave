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
