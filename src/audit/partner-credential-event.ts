import type { SqlExecutor } from "../database/sql-executor";

// Shared by the operator-only partner lifecycle helper, never accepts a payload,
// secret, digest, identity value or arbitrary metadata object.
export async function appendPartnerCredentialEvent(client: SqlExecutor, partnerId: string, credentialId: string,
  event: "credential_created" | "credential_rotated" | "credential_revoked", previousCredentialId?: string): Promise<void> {
  await client.query(`INSERT INTO public.partner_credential_audit_events (partner_id, credential_id, event, previous_credential_id)
    VALUES ($1, $2, $3, $4)`, [partnerId, credentialId, event, previousCredentialId ?? null]);
}
