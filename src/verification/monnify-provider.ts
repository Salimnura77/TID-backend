import type { VerificationInput, VerificationProvider, VerificationResult } from "./verification.provider";

// Runtime boundary deliberately has no transport, credentials, or activation flag.
// Monnify's public NIN/BVN routes are Live-only; no approved Test facility exists
// for this pilot. Offline contract code is separate and never injected here.
export class MonnifyProvider implements VerificationProvider {
  readonly available = false;
  async verify(_input: VerificationInput, _signal: AbortSignal): Promise<VerificationResult> {
    void _input; void _signal;
    return { outcome: "provider_unavailable", reason: "provider_unavailable" };
  }
}
