export const CONSENT_CLOCK = Symbol("CONSENT_CLOCK");
export interface ConsentClock { now(): Date }
export const SHAREABLE_ATTRIBUTES = ["verification_expires_at", "verification_result"] as const;
export type ShareableAttribute = typeof SHAREABLE_ATTRIBUTES[number];
export type ConsentState = "pending" | "approved" | "declined" | "revoked";
export interface InvitationRecord extends Record<string, unknown> {
  id: string; account_id: string; partner_id: string; credential_id: string;
  expires_at: Date; consumed_at: Date | null;
}
export interface ConsentRecord extends Record<string, unknown> {
  id: string; account_id: string; partner_id: string; credential_id: string; invitation_id: string;
  purpose: string; requested_attributes: ShareableAttribute[]; expires_at: Date; created_at: Date;
  state: ConsentState; revision: number; approved_attributes: ShareableAttribute[] | null;
  approved_expires_at: Date | null; decided_at: Date | null; revoked_at: Date | null;
}
export function consentState(record: ConsentRecord, now: Date): ConsentState | "expired" {
  if (record.state === "declined" || record.state === "revoked") return record.state;
  return now >= (record.approved_expires_at ?? record.expires_at) ? "expired" : record.state;
}
export function canonicalAttributes(attributes: readonly ShareableAttribute[]): ShareableAttribute[] {
  return [...attributes].sort();
}
export function consentView(record: ConsentRecord, now: Date) {
  return { id: record.id, purpose: record.purpose, requestedAttributes: record.requested_attributes,
    expiresAt: record.expires_at.toISOString(), status: consentState(record, now), revision: record.revision,
    approvedAttributes: record.approved_attributes, approvedExpiresAt: record.approved_expires_at?.toISOString() ?? null,
    createdAt: record.created_at.toISOString(), decidedAt: record.decided_at?.toISOString() ?? null,
    revokedAt: record.revoked_at?.toISOString() ?? null };
}
