import { describe, expect, it } from "vitest";
import { agentInstanceSchema, governedOutputSchema, roleTemplateSchema, scalingRecommendationSchema, taskLeaseSchema } from "./index.js";

describe("scaling contracts", () => {
  it("defaults a role to one instance and one concurrent task", () => {
    expect(roleTemplateSchema.parse({ roleTemplateId: "coder", role: "coder" })).toMatchObject({
      maxInstances: 1,
      maxConcurrency: 1,
    });
  });

  it("requires task ownership to name an agent instance", () => {
    expect(() => taskLeaseSchema.parse({ taskId: "task-1", leasedAt: new Date().toISOString() })).toThrow();
    expect(agentInstanceSchema.parse({
      agentInstanceId: "coder-1",
      roleTemplateId: "coder",
      role: "coder",
      workstreamId: "ws-1",
      sessionId: "session-1",
      status: "idle",
    }).authority).toBe("executor");
  });

  it("keeps governed outputs explicit about evidence and approval", () => {
    expect(governedOutputSchema.parse({
      outputId: "output-1",
      agentInstanceId: "coder-1",
      kind: "execution",
    })).toMatchObject({ evidenceIds: [], approvalRequired: false });
  });

  it("requires a human decision before scale-up can execute", () => {
    const recommendation = scalingRecommendationSchema.parse({
      recommendationId: "scale-1",
      workstreamId: "ws-1",
      role: "coder",
      requestedInstances: 2,
      reason: "Two independent tasks are ready",
      estimatedTokenCost: 5000,
    });
    expect(recommendation.status).toBe("pending");
    expect(recommendation.approvedBy).toBeUndefined();
  });
});
