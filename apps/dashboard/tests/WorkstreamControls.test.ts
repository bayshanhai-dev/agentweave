import { describe, expect, it } from "vitest";
import { buildCreateWorkstreamBody } from "../src/WorkstreamControls";

const defaultValues = {
  goal: "  Build an accessible editor  ",
  templateId: "software-development",
  workspace: "  /workspaces/editor  ",
  provider: "codex",
  model: "gpt-5.6-luna",
  roleProviders: {
    pm: "",
    pe: "",
    frontend: "",
    backend: "",
    qa: "",
    devops: "",
  },
};

describe("WorkstreamControls create request", () => {
  it("submits no roleProviders field when every role uses Default", () => {
    expect(buildCreateWorkstreamBody(defaultValues)).toEqual({
      goal: "Build an accessible editor",
      templateId: "software-development",
      workspaceRoot: "/workspaces/editor",
      tool: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("submits QA and DevOps Ollama overrides alongside existing fields", () => {
    expect(
      buildCreateWorkstreamBody({
        ...defaultValues,
        roleProviders: {
          ...defaultValues.roleProviders,
          qa: "ollama",
          devops: "ollama",
        },
      }),
    ).toEqual({
      goal: "Build an accessible editor",
      templateId: "software-development",
      workspaceRoot: "/workspaces/editor",
      tool: "codex",
      model: "gpt-5.6-luna",
      roleProviders: {
        qa: { tool: "ollama" },
        devops: { tool: "ollama" },
      },
    });
  });
});
