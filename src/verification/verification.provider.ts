export const VERIFICATION_PROVIDER = Symbol("VERIFICATION_PROVIDER");
export const OUTCOME_REASONS = {
  verified: ["exact_match"],
  needs_review: ["partial_match", "transposed_match", "provider_pending"],
  unable_to_verify: ["no_match", "identity_mismatch", "provider_unverified"],
  timeout: ["provider_timeout", "submission_timeout"],
  provider_unavailable: ["provider_unavailable", "provider_access_denied", "provider_rate_limited", "invalid_response"],
} as const;
export type VerificationOutcome = keyof typeof OUTCOME_REASONS;
export type VerificationResult = {
  [State in VerificationOutcome]: { readonly outcome: State; readonly reason: typeof OUTCOME_REASONS[State][number] }
}[VerificationOutcome];

export interface VerificationInput {
  readonly nin: string;
  readonly firstname: string;
  readonly lastname: string;
}
export interface VerificationProvider {
  readonly available: boolean;
  verify(input: VerificationInput, signal: AbortSignal): Promise<VerificationResult>;
}

// Rebuild from fixed codes even when an injected/replacement adapter returns
// extra metadata or throws. Never carry upstream data into storage or errors.
export function safeResult(value: unknown): VerificationResult {
  if (value && typeof value === "object") {
    const { outcome, reason } = value as Record<string, unknown>;
    if (typeof outcome === "string" && Object.hasOwn(OUTCOME_REASONS, outcome) && typeof reason === "string" &&
        (OUTCOME_REASONS[outcome as VerificationOutcome] as readonly string[]).includes(reason)) {
      return { outcome, reason } as VerificationResult;
    }
  }
  return { outcome: "provider_unavailable", reason: "invalid_response" };
}
