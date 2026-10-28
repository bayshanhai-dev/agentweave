import {
  providerToolSchema,
  resolveProviderModel,
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

export function normalizeRoleProviders(value: unknown): RoleProviders {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return {};
    }
  }

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return {};
  const parsed = roleProvidersSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {};
}

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
    if (!provider.tool) return {};
    const model = resolveProviderModel(provider.tool, provider.model);
    return { provider: provider.tool, ...(model ? { model } : {}) };
  }
  const tool = override.tool ?? provider.tool;
  if (!tool) return {};
  const model =
    override.model ??
    (override.tool === undefined || override.tool === provider.tool ? provider.model : undefined);
  const effectiveModel = resolveProviderModel(tool, model);
  return { provider: tool, ...(effectiveModel ? { model: effectiveModel } : {}) };
}

/**
 * Find the agent a recipient string refers to. Callers address recipients in
 * several forms: the canonical full agent id ("<workstreamId>:qa-5"), the
 * short instance name ("qa-5"), or the role name ("qa"). Agent ids stored on
 * a workstream are the full form, so an exact-id-only lookup silently misses
 * the short and role forms - which used to make routeForRecipient return {}
 * and drop those turns onto the worker's global provider fallback (#153).
 */
export function agentForRecipient<T extends { id: string; role: string }>(
  agents: readonly T[],
  recipientId: string,
): T | undefined {
  return (
    agents.find((agent) => agent.id === recipientId) ??
    agents.find((agent) => agent.id.split(":").pop() === recipientId) ??
    agents.find((agent) => agent.role === recipientId)
  );
}

export function routeForRecipient(
  workstream: WorkstreamProviderRouting,
  recipientId: string,
): EffectiveProvider {
  const recipient = agentForRecipient(workstream.agents, recipientId);
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
