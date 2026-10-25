import type { ProviderError, RetryClass } from "./types.js";

export type ProviderFailureClassification = Pick<ProviderError, "category" | "retry" | "code">;

export function providerError(message: string, category: ProviderError["category"], retry: RetryClass, extra: Partial<ProviderError> = {}): ProviderError {
  return { code: extra.code ?? category, message, category, retry, ...extra };
}

export function redactSecrets(value: string): string {
  return value.replace(/(authorization\s*:\s*bearer\s+|api[_-]?key\s*[=:]\s*|token\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

/** Classifies only provider failures with a known operational remedy. */
export function classifyProviderFailure(input: {
  message: string;
  statusCode?: number;
  code?: string;
}): ProviderFailureClassification | undefined {
  const message = redactSecrets(input.message);
  const suppliedCode = input.code?.trim() ? redactSecrets(input.code.trim()) : undefined;
  const signal = `${message}\n${suppliedCode ?? ""}`;
  const classification = (
    category: ProviderError["category"],
    retry: RetryClass,
    fallbackCode: string,
  ): ProviderFailureClassification => ({
    category,
    retry,
    code: suppliedCode ?? fallbackCode,
  });

  if (/usage[ _-]?limit|quota|limit\s+reached|insufficient[ _-]?quota|billing/i.test(signal)) {
    return classification("rate_limit", "user-action-required", "PROVIDER_USAGE_LIMIT");
  }
  if (input.statusCode === 429 || /\bhttp\s*429\b|rate[ _-]?limit|too\s+many\s+requests/i.test(signal)) {
    return classification("rate_limit", "retryable", "PROVIDER_RATE_LIMIT");
  }
  if (
    input.statusCode === 401 ||
    input.statusCode === 403 ||
    /\bhttp\s*(?:401|403)\b|unauthori[sz]ed|authentication|refresh\s+token|invalid[ _-]?api[ _-]?key/i.test(signal)
  ) {
    return classification("authentication", "user-action-required", "PROVIDER_AUTHENTICATION");
  }
  if (/timed\s+out|timeout|etimedout|deadline\s+exceeded/i.test(signal)) {
    return classification("timeout", "retryable", "PROVIDER_TIMEOUT");
  }
  return undefined;
}
