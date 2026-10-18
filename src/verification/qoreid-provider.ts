import type { QoreidConfig } from "../config/runtime-config";
import type { VerificationInput, VerificationProvider, VerificationResult } from "./verification.provider";
import { isSandboxInput } from "./sandbox-input";

type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;
const unavailable = (): VerificationResult => ({ outcome: "provider_unavailable", reason: "provider_unavailable" });
const httpFailure = (status: number): VerificationResult => ({ outcome: "provider_unavailable",
  reason: status === 401 || status === 403 ? "provider_access_denied" : status === 429 ? "provider_rate_limited" : "provider_unavailable" });
const invalid = (): VerificationResult => ({ outcome: "provider_unavailable", reason: "invalid_response" });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
class ProviderPayloadError extends Error { constructor() { super("Invalid provider response."); } }

// Only fixed outcome codes cross this boundary. id/applicant/nin/photo/insight
// and provider error bodies are never returned, logged or retained.
export function mapQoreidNinResponse(value: unknown): VerificationResult {
  const body = record(value);
  const status = record(body.status);
  if (status.state === "in_progress" && status.status === "in_progress") {
    return { outcome: "needs_review", reason: "provider_pending" };
  }
  if (status.state !== "complete") return invalid();
  if (status.status === "id_mismatch") return { outcome: "unable_to_verify", reason: "identity_mismatch" };
  if (status.status !== "verified" && status.status !== "unverified") return invalid();
  const check = record(record(body.summary).nin_check);
  if (check.status === "NO_MATCH") return { outcome: "unable_to_verify", reason: "no_match" };
  if (status.status === "unverified") return { outcome: "unable_to_verify", reason: "provider_unverified" };
  const matches = record(check.fieldMatches);
  if (typeof matches.firstname !== "boolean" || typeof matches.lastname !== "boolean") return invalid();
  if (check.status === "EXACT_MATCH" && matches.firstname === true && matches.lastname === true) {
    return { outcome: "verified", reason: "exact_match" };
  }
  if (check.status === "PARTIAL_MATCH") return { outcome: "needs_review", reason: "partial_match" };
  if (check.status === "TRANSPOSED_MATCH") return { outcome: "needs_review", reason: "transposed_match" };
  return invalid();
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 1024 * 1024;
  if (!response.body || Number(response.headers.get("content-length")) > limit) throw new ProviderPayloadError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ProviderPayloadError();
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ProviderPayloadError(); }
  } finally {
    // Do not expose body/URL/exception details, including cancellation failures.
    try { await reader.cancel(); } catch { /* No logging. */ }
    reader.releaseLock();
  }
}

export class QoreidProvider implements VerificationProvider {
  readonly available: boolean;
  constructor(private readonly config?: QoreidConfig, private readonly transport: ProviderFetch = fetch) {
    this.available = config?.mode === "sandbox" && config.route === "nin";
  }

  async verify(input: VerificationInput, signal: AbortSignal): Promise<VerificationResult> {
    if (!this.available || !this.config || !isSandboxInput(input)) return unavailable();
    try {
      const auth = await this.transport("https://api.qoreid.com/token", {
        method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ clientId: this.config.testClientId, secret: this.config.testClientSecret }),
      });
      if (auth.status !== 201) { await auth.body?.cancel().catch(() => undefined); return httpFailure(auth.status); }
      // Official /token OpenAPI: accessToken, expiresIn, tokenType. No token cache.
      const tokenBody = record(await boundedJson(auth, signal));
      if (tokenBody.tokenType !== "Bearer" || typeof tokenBody.accessToken !== "string" ||
          !/^[A-Za-z0-9._~+/=-]{1,16384}$/.test(tokenBody.accessToken)) return invalid();
      const response = await this.transport(`https://api.qoreid.com/v1/ng/identities/nin/${input.nin}`, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${tokenBody.accessToken}` },
        body: JSON.stringify({ firstname: input.firstname, lastname: input.lastname }),
      });
      if (response.status === 504) { await response.body?.cancel().catch(() => undefined); return { outcome: "timeout", reason: "provider_timeout" }; }
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return httpFailure(response.status); }
      return mapQoreidNinResponse(await boundedJson(response, signal));
    } catch (error) {
      return signal.aborted ? { outcome: "timeout", reason: "provider_timeout" } : error instanceof ProviderPayloadError ? invalid() : unavailable();
    }
  }
}
