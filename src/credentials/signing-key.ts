import { createHash } from "node:crypto";
import type { JWK } from "jose";

export const SIGNING_KEYS = Symbol("SIGNING_KEYS");
export interface SigningKey {
  readonly id: string;
  readonly algorithm: "RS256";
  readonly mode: "test" | "production";
  publicKey(): Promise<JWK>;
  sign(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}
export interface SigningKeys {
  readonly mode: "test" | "production" | "disabled";
  active(): Promise<SigningKey>;
  version(id: string): Promise<SigningKey>;
}

// Production dependency contract: implemented by a managed KMS/HSM SDK adapter.
// No private key/export operation or local production key storage is available.
export interface ManagedSigningBackend {
  publicKey(version: string): Promise<JWK>;
  signDigest(request: { readonly version: string; readonly algorithm: "RSASSA_PKCS1_V1_5_SHA_256";
    readonly digest: Uint8Array; readonly signal: AbortSignal }): Promise<Uint8Array>;
}
export class ManagedSigningKey implements SigningKey {
  readonly algorithm = "RS256" as const;
  readonly mode = "production" as const;
  constructor(readonly id: string, private readonly remoteVersion: string, private readonly backend: ManagedSigningBackend) {}
  publicKey(): Promise<JWK> { return this.backend.publicKey(this.remoteVersion); }
  sign(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return this.backend.signDigest({ version: this.remoteVersion, algorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      digest: createHash("sha256").update(input).digest(), signal });
  }
}
