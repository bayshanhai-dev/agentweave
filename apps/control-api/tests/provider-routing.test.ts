import { describe, expect, it } from "vitest";
import {
  agentForRecipient,
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

describe("recipient resolution against full agent ids (#153)", () => {
  // Production shape: agents carry "<workstreamId>:<instance>" ids, while the
  // human message API is addressed with the short instance name or the role.
  const productionShape = {
    provider: {},
    roleProviders: {
      qa: { tool: "codex" as const, model: "gpt-5.6-luna" },
      maintainer: { tool: "ollama" as const, model: "qwen3-coder:30b" },
    },
    agents: [
      { id: "ws-1:maintainer-1", role: "maintainer" },
      { id: "ws-1:qa-5", role: "qa" },
    ],
  };

  it("resolves the full id, the short instance name, and the role name", () => {
    expect(agentForRecipient(productionShape.agents, "ws-1:qa-5")?.role).toBe("qa");
    expect(agentForRecipient(productionShape.agents, "qa-5")?.role).toBe("qa");
    expect(agentForRecipient(productionShape.agents, "qa")?.role).toBe("qa");
    expect(agentForRecipient(productionShape.agents, "nobody-9")).toBeUndefined();
  });

  it("stamps the role route for short-name and role addressing, not the fallback", () => {
    expect(routeForRecipient(productionShape, "ws-1:qa-5"))
      .toEqual({ provider: "codex", model: "gpt-5.6-luna" });
    expect(routeForRecipient(productionShape, "qa-5"))
      .toEqual({ provider: "codex", model: "gpt-5.6-luna" });
    expect(routeForRecipient(productionShape, "qa"))
      .toEqual({ provider: "codex", model: "gpt-5.6-luna" });
    expect(routeForRecipient(productionShape, "maintainer-1"))
      .toEqual({ provider: "ollama", model: "qwen3-coder:30b" });
    expect(routeForRecipient(productionShape, "nobody-9")).toEqual({});
  });
});
