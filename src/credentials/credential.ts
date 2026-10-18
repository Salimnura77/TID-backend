export const CREDENTIAL_CLOCK = Symbol("CREDENTIAL_CLOCK");
export interface CredentialClock { now(): Date }
export const CREDENTIAL_ISSUER = "urn:trueid:test:issuer";
export const CREDENTIAL_AUDIENCE = "urn:trueid:test:credential";
export const CREDENTIAL_TYPE = "trueid-test-credential+jwt";
export const CREDENTIAL_TTL_SECONDS = 300;
export type StoredCredentialState = "active" | "revoked" | "superseded";
export interface CredentialRecord extends Record<string, unknown> {
  id: string; account_id: string; verification_id: string; signing_key_id: string;
  state: StoredCredentialState; issued_at: Date; expires_at: Date; revoked_at: Date | null;
}
export function credentialStatus(record: CredentialRecord, now: Date): StoredCredentialState | "expired" {
  return record.state === "active" && now.getTime() >= record.expires_at.getTime() ? "expired" : record.state;
}
export function credentialView(record: CredentialRecord, now: Date) {
  return { id: record.id, status: credentialStatus(record, now), environment: "test" as const, keyId: record.signing_key_id,
    issuedAt: record.issued_at.toISOString(), expiresAt: record.expires_at.toISOString(), revokedAt: record.revoked_at?.toISOString() ?? null };
}
export function credentialClaims(record: CredentialRecord) {
  return { iss: CREDENTIAL_ISSUER, aud: CREDENTIAL_AUDIENCE, jti: record.id,
    iat: Math.floor(record.issued_at.getTime() / 1000), exp: Math.floor(record.expires_at.getTime() / 1000),
    verification: "verified" as const, test: true as const };
}
