import { Inject, Injectable } from "@nestjs/common";
import type { JWK } from "jose";
import { AuditService } from "../audit/audit.service";
import type { SqlExecutor } from "../database/sql-executor";
import { ApiError } from "../http/api-error";
import type { CredentialRecord } from "./credential";

const columns = "id, account_id, verification_id, signing_key_id, state, issued_at, expires_at, revoked_at";
@Injectable()
export class CredentialRepository {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async findVerification(client: SqlExecutor, accountId: string, verificationId: string): Promise<CredentialRecord | undefined> {
    return (await client.query<CredentialRecord>(`SELECT ${columns} FROM public.credentials WHERE account_id = $1 AND verification_id = $2`, [accountId, verificationId])).rows[0];
  }
  async read(client: SqlExecutor, accountId: string, id: string): Promise<CredentialRecord> {
    const row = (await client.query<CredentialRecord>(`SELECT ${columns} FROM public.credentials WHERE account_id = $1 AND id = $2`, [accountId, id])).rows[0];
    if (!row) throw new ApiError(404, "not_found");
    return row;
  }
  async publicKey(client: SqlExecutor, id: string): Promise<JWK> {
    const row = (await client.query<{ public_key: JWK }>("SELECT public_key FROM public.credential_signing_keys WHERE id = $1", [id])).rows[0];
    if (!row) throw new ApiError(400, "credential_invalid");
    return row.public_key;
  }
  private async registerKey(client: SqlExecutor, id: string, publicKey: JWK): Promise<void> {
    await client.query(`INSERT INTO public.credential_signing_keys (id, algorithm, public_key)
      VALUES ($1, 'RS256', $2::jsonb) ON CONFLICT (id) DO NOTHING`, [id, JSON.stringify(publicKey)]);
    const stored = await this.publicKey(client, id);
    if (stored.n !== publicKey.n || stored.e !== publicKey.e || stored.kty !== publicKey.kty) throw new ApiError(503, "signing_unavailable");
  }
  async issue(client: SqlExecutor, plan: CredentialRecord, publicKey: JWK, now: Date): Promise<{ record: CredentialRecord; created: boolean }> {
    const existing = await this.findVerification(client, plan.account_id, plan.verification_id);
    if (existing) return { record: existing, created: false };
    await this.registerKey(client, plan.signing_key_id, publicKey);
    // A new verified attempt creates a new reference. Prior IDs remain terminal;
    // no consent rows are selected or changed, and grants never move to the new ID.
    const old = await client.query<CredentialRecord>(`UPDATE public.credentials SET state = 'superseded', revoked_at = $2
      WHERE account_id = $1 AND state = 'active' RETURNING ${columns}`, [plan.account_id, now]);
    for (const row of old.rows) await this.audit.credentialState(client, plan.account_id, row.id, "credential_superseded");
    const record = (await client.query<CredentialRecord>(`INSERT INTO public.credentials
      (id, account_id, verification_id, signing_key_id, issued_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${columns}`,
    [plan.id, plan.account_id, plan.verification_id, plan.signing_key_id, plan.issued_at, plan.expires_at])).rows[0]!;
    await this.audit.credentialState(client, plan.account_id, record.id, "credential_issued");
    return { record, created: true };
  }
  async revoke(client: SqlExecutor, accountId: string, id: string, now: Date): Promise<CredentialRecord> {
    const old = await this.read(client, accountId, id);
    if (old.state !== "active") return old;
    const record = (await client.query<CredentialRecord>(`UPDATE public.credentials SET state = 'revoked', revoked_at = $3
      WHERE account_id = $1 AND id = $2 AND state = 'active' RETURNING ${columns}`, [accountId, id, now])).rows[0]!;
    await this.audit.credentialState(client, accountId, id, "credential_revoked");
    return record;
  }
}
