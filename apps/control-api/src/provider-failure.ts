export type ProviderFailureAction = "park-for-human" | "default";

export type ProviderFailureMessageInput = {
  provider: string;
  model: string;
  role: string;
  task: string;
};

export function providerFailureAction(input: {
  errorCategory?: string;
  errorRetry?: string;
}): ProviderFailureAction {
  return input.errorCategory === "rate_limit" ||
    input.errorCategory === "authentication" ||
    input.errorRetry === "user-action-required"
    ? "park-for-human"
    : "default";
}

export function buildProviderLimitMessage(input: ProviderFailureMessageInput): string {
  return `Provider ${input.provider} using model ${input.model} hit a usage limit while role ${input.role} was working on task "${input.task}". The run is parked, not failed. Wait for the limit window to reset or switch the ${input.role} role to another model, then approve/resume.`;
}

export function buildProviderAuthenticationMessage(input: ProviderFailureMessageInput): string {
  return `Provider ${input.provider} using model ${input.model} requires authentication while role ${input.role} was working on task "${input.task}". The run is parked, not failed. Sign the provider in again, then approve/resume.`;
}
