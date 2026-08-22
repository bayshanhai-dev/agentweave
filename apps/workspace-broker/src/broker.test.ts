import { describe, expect, it } from "vitest";
import { WorkspaceBroker } from "./broker.js";

describe("WorkspaceBroker", () => {
  it("rejects a workspace outside the authorized root", async () => {
    const broker = new WorkspaceBroker({ allowedRoots: ["/tmp/allowed"] , docker: async () => ({ stdout: "", stderr: "" }) });
    await expect(broker.bind({ workstreamId: "ws-1", hostPath: "/tmp" })).rejects.toThrow();
  });
});
