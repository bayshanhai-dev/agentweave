import type { ProviderError, RetryClass } from "./types.js";

export function providerError(message: string, category: ProviderError["category"], retry: RetryClass, extra: Partial<ProviderError> = {}): ProviderError {
  return { code: extra.code ?? category, message, category, retry, ...extra };
}

export function redactSecrets(value: string): string {
  return value.replace(/(authorization\s*:\s*bearer\s+|api[_-]?key\s*[=:]\s*|token\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
