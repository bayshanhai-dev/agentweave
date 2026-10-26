import { describe, expect, it } from "vitest";
import {
  agentsWithEffectiveProviders,
  normalizeRoleProviders,
  parseProviderConfig,
  resolveEffectiveProvider,
  routeForRecipient,
  stampProviderRoute,
} from "../src/provider-routing.js";

describe("role provider normalization", () => {
  const roleProviders = {
    showrunner: { tool: "codex" as const, model: "gpt-5.6-sol" },
    editor: { model: "gpt-5.6-terra" },
  };

  it("accepts a valid object", () => {
    expect(normalizeRoleProviders(roleProviders)).toEqual(roleProviders);
  });

  it("accepts a valid JSON string", () => {
    expect(normalizeRoleProviders(JSON.stringify(roleProviders))).toEqual(roleProviders);
  });

  it.each([
    ["invalid JSON", "{not-json"],
    ["a JSON non-object", JSON.stringify(42)],
    ["a schema-invalid object", { editor: {} }],
    ["null", null],
  ])("returns an empty object for %s", (_description, value) => {
    expect(normalizeRoleProviders(value)).toEqual({});
  });
});

describe("heterogeneous provider routing", () => {
  const workstream = {
    provider: { tool: "ollama" as const, model: "llama3.1:8b" },
    roleProviders: {
      showrunner: { tool: "codex" as const, model: "gpt-5.6-sol" },
      host: { tool: "codex" as const },
    },
    agents: [
      { id: "agent-showrunner", role: "showrunner" },
      { id: "agent-host", role: "host" },
      { id: "agent-editor", role: "editor" },
    ],
  };

  it("stamps collaboration and task turns for their recipient roles", () => {
    const collaboration = stampProviderRoute(
      { messageType: "collaboration.critique", recipientId: "agent-showrunner" },
      routeForRecipient(workstream, "agent-showrunner"),
    );
    const task = stampProviderRoute(
      { messageType: "request", taskId: "edit-1", recipientId: "agent-editor" },
      routeForRecipient(workstream, "agent-editor"),
    );

    expect(collaboration).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(task).toMatchObject({ provider: "ollama", model: "llama3.1:8b" });

    const toolOnlyCollaboration = stampProviderRoute(
      { messageType: "collaboration.critique", recipientId: "agent-qa" },
      routeForRecipient({
        provider: {},
        roleProviders: { qa: { tool: "ollama" } },
        agents: [{ id: "agent-qa", role: "qa" }],
      }, "agent-qa"),
    );
    expect(toolOnlyCollaboration).toMatchObject({ provider: "ollama", model: "llama3.1:8b" });
  });

  it("applies the role, workstream, then unstamped worker fallback chain", () => {
    expect(resolveEffectiveProvider(workstream.provider, workstream.roleProviders, "editor"))
      .toEqual({ provider: "ollama", model: "llama3.1:8b" });
    expect(resolveEffectiveProvider({}, {}, "editor")).toEqual({});
    expect(resolveEffectiveProvider(workstream.provider, workstream.roleProviders, "host"))
      .toEqual({ provider: "codex" });
  });

  it("rejects an unknown role provider tool with a creation-level 400", () => {
    expect(parseProviderConfig({ roleProviders: { editor: { tool: "unknown" } } }))
      .toMatchObject({ ok: false, statusCode: 400, error: "invalid_role_providers" });
  });

  it("exposes every agent's effective provider and model in snapshots", () => {
    expect(agentsWithEffectiveProviders(workstream.agents, workstream.provider, workstream.roleProviders))
      .toEqual([
        { id: "agent-showrunner", role: "showrunner", provider: "codex", model: "gpt-5.6-sol" },
        { id: "agent-host", role: "host", provider: "codex" },
        { id: "agent-editor", role: "editor", provider: "ollama", model: "llama3.1:8b" },
      ]);
  });
});
