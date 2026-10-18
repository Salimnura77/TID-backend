import type { VerificationInput, VerificationResult } from "./verification.provider";
import { mapMonnifyBvnResponse, mapMonnifyNinResponse, monnifyInvalid, monnifySuccessfulBody,
  monnifyTimeout, monnifyUnavailable, validMonnifyBvnInput, validMonnifyNinInput } from "./monnify-contract";
import type { MonnifyBvnInput } from "./monnify-contract";

type MonnifyPath = "/api/v1/auth/login" | "/api/v1/vas/nin-verification" | "/api/v1/vas/bvn-details-match";
export interface MonnifyContractTransport {
  readonly mode: "contract-test";
  request(url: string, init: RequestInit): Promise<Response>;
}
export interface MonnifyContractCredentials { readonly apiKey: string; readonly secretKey: string }
class InvalidContractResponse extends Error { constructor() { super("Invalid Monnify contract response."); } }
function httpFailure(status: number): VerificationResult {
  return status === 504 ? monnifyTimeout() : { outcome: "provider_unavailable",
    reason: status === 401 || status === 403 ? "provider_access_denied" : status === 429 ? "provider_rate_limited" : "provider_unavailable" };
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 65536;
  const length = response.headers.get("content-length");
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
      (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > limit))) {
    await response.body?.cancel().catch(() => undefined);
    throw new InvalidContractResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new InvalidContractResponse();
      chunks.push(value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new InvalidContractResponse(); }
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } catch { /* Never log body/cancellation details. */ }
    reader.releaseLock();
  }
}

// Offline contract exercise only: there is no default fetch, production host,
// environment loader or Nest provider registration. The runtime MonnifyProvider
// stays unavailable. A mock transport and ephemeral Test-shaped keys are required.
export class MonnifyContractClient {
  readonly #credentials: MonnifyContractCredentials;
  readonly #transport: MonnifyContractTransport;
  constructor(credentials: MonnifyContractCredentials, transport: MonnifyContractTransport) {
    if (transport?.mode !== "contract-test" || typeof transport.request !== "function" ||
        !/^MK_TEST_[A-Za-z0-9_-]{1,128}$/.test(credentials.apiKey) || !/^[\x21-\x7e]{16,512}$/.test(credentials.secretKey)) {
      throw new Error("Invalid Monnify contract-test setup.");
    }
    this.#credentials = Object.freeze({ apiKey: credentials.apiKey, secretKey: credentials.secretKey });
    this.#transport = transport;
  }
  verifyNin(input: VerificationInput, signal: AbortSignal): Promise<VerificationResult> {
    if (!validMonnifyNinInput(input)) return Promise.resolve(monnifyUnavailable());
    const submitted = Object.freeze({ nin: input.nin, firstname: input.firstname, lastname: input.lastname });
    return this.run(signal, (current) => this.exchange("/api/v1/vas/nin-verification", { nin: submitted.nin }, current,
      (value) => mapMonnifyNinResponse(value, submitted)));
  }
  verifyBvn(input: MonnifyBvnInput, signal: AbortSignal): Promise<VerificationResult> {
    if (!validMonnifyBvnInput(input)) return Promise.resolve(monnifyUnavailable());
    const submitted = Object.freeze({ bvn: input.bvn, name: input.name, dateOfBirth: input.dateOfBirth, mobileNo: input.mobileNo });
    return this.run(signal, (current) => this.exchange("/api/v1/vas/bvn-details-match",
      submitted, current, (value) => mapMonnifyBvnResponse(value, submitted)));
  }
  private async run(caller: AbortSignal, work: (signal: AbortSignal) => Promise<VerificationResult>): Promise<VerificationResult> {
    if (caller.aborted) return monnifyTimeout();
    const controller = new AbortController();
    const abort = () => controller.abort();
    caller.addEventListener("abort", abort, { once: true });
    const deadline = new Promise<VerificationResult>((resolve) => controller.signal.addEventListener("abort", () => resolve(monnifyTimeout()), { once: true }));
    const timer = setTimeout(abort, 5000);
    try {
      return await Promise.race([work(controller.signal).catch((error: unknown) => controller.signal.aborted ? monnifyTimeout()
        : error instanceof InvalidContractResponse ? monnifyInvalid() : monnifyUnavailable()), deadline]);
    } finally { clearTimeout(timer); caller.removeEventListener("abort", abort); controller.abort(); }
  }
  private async exchange(path: Exclude<MonnifyPath, "/api/v1/auth/login">, body: Record<string, string>, signal: AbortSignal,
    map: (value: unknown) => VerificationResult): Promise<VerificationResult> {
    const basic = Buffer.from(`${this.#credentials.apiKey}:${this.#credentials.secretKey}`, "utf8").toString("base64");
    const auth = await this.request("/api/v1/auth/login", signal, `Basic ${basic}`);
    if (auth.status !== 200) { await auth.body?.cancel().catch(() => undefined); return httpFailure(auth.status); }
    const token = monnifySuccessfulBody(await boundedJson(auth, signal));
    if (!token || typeof token.accessToken !== "string" || !/^[A-Za-z0-9._~+/=-]{1,16384}$/.test(token.accessToken) ||
        !Number.isInteger(token.expiresIn) || Number(token.expiresIn) < 1 || Number(token.expiresIn) > 86400) return monnifyInvalid();
    signal.throwIfAborted();
    const response = await this.request(path, signal, `Bearer ${token.accessToken}`, body);
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return httpFailure(response.status); }
    return map(await boundedJson(response, signal));
  }
  private request(path: MonnifyPath, signal: AbortSignal, authorization: string, body?: Record<string, string>) {
    return this.#transport.request(`https://sandbox.monnify.com${path}`, {
      method: "POST", redirect: "error", signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authorization },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
}
