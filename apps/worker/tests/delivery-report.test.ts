import { describe, expect, it, vi } from "vitest";
import { reportDelivery } from "../src/delivery-report.js";

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
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
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
