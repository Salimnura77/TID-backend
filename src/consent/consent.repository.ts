import { Injectable } from "@nestjs/common";
import type { SqlExecutor } from "../database/sql-executor";
import { ApiError } from "../http/api-error";
import type { ConsentRecord, InvitationRecord, ShareableAttribute } from "./consent";

const columns = "id, account_id, partner_id, credential_id, invitation_id, purpose, requested_attributes, expires_at, created_at, state, revision, approved_attributes, approved_expires_at, decided_at, revoked_at";
@Injectable()
export class ConsentRepository {
  async invitation(client: SqlExecutor, partnerId: string, digest: string, lock = false): Promise<InvitationRecord> {
    const row = (await client.query<InvitationRecord>(`SELECT id, account_id, partner_id, credential_id, expires_at, consumed_at
      FROM public.consent_invitations WHERE partner_id = $1 AND token_digest = $2${lock ? " FOR UPDATE" : ""}`, [partnerId, digest])).rows[0];
    if (!row) throw new ApiError(404, "not_found");
    return row;
  }
  async invite(client: SqlExecutor, accountId: string, partnerId: string, credentialId: string, digest: string, now: Date, expiry: Date) {
    await client.query(`INSERT INTO public.consent_invitations (account_id, partner_id, credential_id, token_digest, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)`, [accountId, partnerId, credentialId, digest, now, expiry]);
  }
  async create(client: SqlExecutor, invitation: InvitationRecord, purpose: string, attributes: ShareableAttribute[], expiry: Date, now: Date): Promise<ConsentRecord> {
    await client.query("UPDATE public.consent_invitations SET consumed_at = $2 WHERE id = $1", [invitation.id, now]);
    return (await client.query<ConsentRecord>(`INSERT INTO public.consent_requests
      (invitation_id, account_id, partner_id, credential_id, purpose, requested_attributes, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${columns}`,
    [invitation.id, invitation.account_id, invitation.partner_id, invitation.credential_id, purpose, attributes, expiry, now])).rows[0]!;
  }
  async read(client: SqlExecutor, scope: { accountId: string } | { partnerId: string }, id: string, lock = false): Promise<ConsentRecord> {
    const accountScope = "accountId" in scope;
    const row = (await client.query<ConsentRecord>(`SELECT ${columns} FROM public.consent_requests
      WHERE ${accountScope ? "account_id" : "partner_id"} = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [accountScope ? scope.accountId : scope.partnerId, id])).rows[0];
    if (!row) throw new ApiError(404, "not_found");
    return row;
  }
  async list(client: SqlExecutor, accountId: string): Promise<ConsentRecord[]> {
    return (await client.query<ConsentRecord>(`SELECT ${columns} FROM public.consent_requests
      WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [accountId])).rows;
  }
  async decide(client: SqlExecutor, record: ConsentRecord, state: "approved" | "declined", attributes: ShareableAttribute[] | null, expiry: Date | null, now: Date): Promise<ConsentRecord> {
    return (await client.query<ConsentRecord>(`UPDATE public.consent_requests SET state = $2, revision = revision + 1,
      approved_attributes = $3, approved_expires_at = $4, decided_at = $5 WHERE id = $1 RETURNING ${columns}`,
    [record.id, state, attributes, expiry, now])).rows[0]!;
  }
  async revoke(client: SqlExecutor, record: ConsentRecord, now: Date): Promise<ConsentRecord> {
    return (await client.query<ConsentRecord>(`UPDATE public.consent_requests SET state = 'revoked', revision = revision + 1,
      revoked_at = $2 WHERE id = $1 RETURNING ${columns}`, [record.id, now])).rows[0]!;
  }
}
