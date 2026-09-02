import { describe, expect, it } from "vitest";
import { isProjectionGap, reconcileSnapshot } from "../src/projection-state";

describe("dashboard projection state", () => {
  it("detects missed projection cursors", () => {
    expect(isProjectionGap(4, 5)).toBe(false);
    expect(isProjectionGap(4, 7)).toBe(true);
  });

  it("replaces client state with a versioned server snapshot", () => {
    const workstream = { id: "ws-1", status: "completed" };
    expect(reconcileSnapshot({ schemaVersion: 1, cursor: 9, workstream })).toBe(workstream);
  });
});
