import { describe, expect, it } from "vitest";
import {
  aggregateDeliveryStatus,
  nextDeliveryStatus,
} from "../src/repositories/message-repository.js";

describe("nextDeliveryStatus", () => {
  it("advances through the lifecycle in order", () => {
    expect(nextDeliveryStatus("pending", "delivered")).toBe("delivered");
    expect(nextDeliveryStatus("delivered", "gated")).toBe("gated");
    expect(nextDeliveryStatus("delivered", "claimed")).toBe("claimed");
    expect(nextDeliveryStatus("gated", "claimed")).toBe("claimed");
    expect(nextDeliveryStatus("claimed", "acknowledged")).toBe("acknowledged");
  });

  it("never regresses a live delivery", () => {
    expect(nextDeliveryStatus("claimed", "delivered")).toBe("claimed");
    expect(nextDeliveryStatus("claimed", "gated")).toBe("claimed");
    expect(nextDeliveryStatus("gated", "delivered")).toBe("gated");
    expect(nextDeliveryStatus("gated", "gated")).toBe("gated");
  });

  it("keeps terminal states sticky", () => {
    expect(nextDeliveryStatus("acknowledged", "failed")).toBe("acknowledged");
    expect(nextDeliveryStatus("acknowledged", "claimed")).toBe("acknowledged");
    expect(nextDeliveryStatus("failed", "claimed")).toBe("failed");
    expect(nextDeliveryStatus("failed", "acknowledged")).toBe("failed");
  });

  it("lets failure land from any live state", () => {
    expect(nextDeliveryStatus("pending", "failed")).toBe("failed");
    expect(nextDeliveryStatus("delivered", "failed")).toBe("failed");
    expect(nextDeliveryStatus("gated", "failed")).toBe("failed");
    expect(nextDeliveryStatus("claimed", "failed")).toBe("failed");
  });
});

describe("aggregateDeliveryStatus", () => {
  it("is pending for no deliveries", () => {
    expect(aggregateDeliveryStatus([])).toBe("pending");
    expect(aggregateDeliveryStatus(["pending", "pending"])).toBe("pending");
  });

  it("surfaces failure over every other state", () => {
    expect(aggregateDeliveryStatus(["acknowledged", "failed"])).toBe("failed");
    expect(aggregateDeliveryStatus(["claimed", "failed"])).toBe("failed");
  });

  it("is acknowledged only once every recipient acknowledged", () => {
    expect(aggregateDeliveryStatus(["acknowledged", "acknowledged"])).toBe("acknowledged");
    expect(aggregateDeliveryStatus(["acknowledged", "claimed"])).toBe("claimed");
    expect(aggregateDeliveryStatus(["acknowledged", "delivered"])).toBe("delivered");
  });

  it("ranks claimed above gated above delivered", () => {
    expect(aggregateDeliveryStatus(["gated", "claimed"])).toBe("claimed");
    expect(aggregateDeliveryStatus(["gated", "delivered"])).toBe("gated");
    expect(aggregateDeliveryStatus(["delivered", "pending"])).toBe("delivered");
  });
});
