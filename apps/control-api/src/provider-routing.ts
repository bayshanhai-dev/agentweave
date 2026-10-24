import {
  providerToolSchema,
  roleProvidersSchema,
  type ProviderSelection,
  type RoleProviders,
} from "@agentweave/protocol";

export type WorkstreamProviderRouting = {
  provider: ProviderSelection;
  roleProviders: RoleProviders;
  agents: Array<{ id: string; role: string }>;
};

export type EffectiveProvider = { provider?: string; model?: string };

export type ProviderConfigResult =
  | { ok: true; provider: ProviderSelection; roleProviders: RoleProviders }
  | { ok: false; statusCode: 400; error: string; detail: string };

export function parseProviderConfig(input: {
  tool?: unknown;
  model?: unknown;
  roleProviders?: unknown;
}): ProviderConfigResult {
  const provider: ProviderSelection = {};
  if (input.tool !== undefined) {
    const parsedTool = providerToolSchema.safeParse(input.tool);
    if (!parsedTool.success) {
      return {
        ok: false,
        statusCode: 400,
        error: "unsupported_provider_tool",
        detail: `Unknown workstream provider tool: ${String(input.tool)}`,
      };
    }
    provider.tool = parsedTool.data;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !input.model.trim()) {
      return { ok: false, statusCode: 400, error: "invalid_provider_model", detail: "model must be a non-empty string" };
    }
    provider.model = input.model.trim();
  }

  const parsedOverrides = roleProvidersSchema.safeParse(input.roleProviders ?? {});
  if (!parsedOverrides.success) {
    const issue = parsedOverrides.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "roleProviders";
    return {
      ok: false,
      statusCode: 400,
      error: "invalid_role_providers",
      detail: `${path}: ${issue?.message ?? "invalid provider override"}`,
    };
  }
  return { ok: true, provider, roleProviders: parsedOverrides.data };
}

/**
 * Resolve the route known by the control plane. A role that changes provider
 * without naming a model uses that provider's own default rather than carrying
 * a model name across provider boundaries.
 */
export function resolveEffectiveProvider(
  provider: ProviderSelection,
  roleProviders: RoleProviders,
  role: string,
): EffectiveProvider {
  const override = roleProviders[role];
  if (!override) {
    return provider.tool
      ? { provider: provider.tool, ...(provider.model ? { model: provider.model } : {}) }
      : {};
  }
  const tool = override.tool ?? provider.tool;
  if (!tool) return {};
  const model =
    override.model ??
    (override.tool === undefined || override.tool === provider.tool ? provider.model : undefined);
  return { provider: tool, ...(model ? { model } : {}) };
}

export function routeForRecipient(
  workstream: WorkstreamProviderRouting,
  recipientId: string,
): EffectiveProvider {
  const recipient = workstream.agents.find((agent) => agent.id === recipientId);
  return recipient
    ? resolveEffectiveProvider(workstream.provider, workstream.roleProviders, recipient.role)
    : {};
}

export function stampProviderRoute<T extends Record<string, unknown>>(
  payload: T,
  route: EffectiveProvider,
): T & EffectiveProvider {
  return { ...payload, ...route };
}

export function agentsWithEffectiveProviders<T extends { role: string }>(
  agents: T[],
  provider: ProviderSelection,
  roleProviders: RoleProviders,
): Array<T & EffectiveProvider> {
  return agents.map((agent) => ({
    ...agent,
    ...resolveEffectiveProvider(provider, roleProviders, agent.role),
  }));
}
