import { Inject, Injectable } from "@nestjs/common";
import type { SqlExecutor } from "../database/sql-executor";
import { DatabaseService } from "../database/database.service";
import { ApiError } from "../http/api-error";
import { matchingDigest, parsePartnerKey } from "./partner-key";
import type { PartnerIdentity } from "./partner-key";
import type { PartnerPermission } from "./partner-permission";

interface PartnerRow extends Record<string, unknown> { id: string; name: string; status: string }
interface CredentialRow extends Record<string, unknown> {
  credential_id: string; key_digest: string; permissions: PartnerPermission[]; revoked_at: Date | null;
}
@Injectable()
export class PartnersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async authenticate(key: string, permission: PartnerPermission): Promise<PartnerIdentity> {
    const parsed = parsePartnerKey(key);
    if (!parsed) throw new ApiError(401, "unauthenticated");
    return this.database.withClient(async (client) => {
      const row = (await client.query<PartnerRow & CredentialRow>(`SELECT p.id, p.name, p.status,
        c.id AS credential_id, c.key_digest, c.permissions, c.revoked_at
        FROM public.partner_clients p JOIN public.partner_api_credentials c ON c.partner_id = p.id
        WHERE p.id = $1 AND c.key_digest = $2`, [parsed.id, parsed.keyDigest])).rows[0];
      if (!row || row.status !== "active") throw new ApiError(401, "unauthenticated");
      this.checkCredential(row, parsed.keyDigest, permission);
      return { ...parsed, credentialId: row.credential_id };
    });
  }
  // Mutating/disclosure callers lock the account first, then this partner. Recheck
  // the authenticated key here so disabling a client also wins after guard execution.
  async requireAuthenticated(client: SqlExecutor, identity: PartnerIdentity, permission: PartnerPermission) {
    const row = await this.row(client, identity.id, true);
    if (!row || row.status !== "active") throw new ApiError(401, "unauthenticated");
    const credential = (await client.query<CredentialRow>(`SELECT id AS credential_id, key_digest, permissions, revoked_at
      FROM public.partner_api_credentials WHERE partner_id = $1 AND id = $2 FOR UPDATE`, [identity.id, identity.credentialId])).rows[0];
    this.checkCredential(credential, identity.keyDigest, permission);
    return { id: row.id, name: row.name };
  }
  private checkCredential(row: CredentialRow | undefined, digest: string, permission: PartnerPermission) {
    if (!row || row.revoked_at || !matchingDigest(digest, row.key_digest)) throw new ApiError(401, "unauthenticated");
    if (!row.permissions.includes(permission)) throw new ApiError(403, "forbidden");
  }
  async requireActive(client: SqlExecutor, id: string, lock = true) {
    const row = await this.row(client, id, lock);
    if (!row || row.status !== "active") throw new ApiError(404, "not_found");
    return { id: row.id, name: row.name };
  }
  async describe(client: SqlExecutor, id: string) {
    const row = await this.row(client, id, false);
    if (!row) throw new ApiError(404, "not_found");
    return { id: row.id, name: row.name, status: row.status };
  }
  private async row(client: SqlExecutor, id: string, lock: boolean) {
    return (await client.query<PartnerRow>(`SELECT id, name, status FROM public.partner_clients
      WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
  }
  // Called only after Consent authorizes disclosure, under the same lifecycle locks.
  async pairwiseIdentifier(client: SqlExecutor, accountId: string, partnerId: string): Promise<string> {
    await client.query(`INSERT INTO public.partner_pairwise_ids (account_id, partner_id)
      VALUES ($1, $2) ON CONFLICT (account_id, partner_id) DO NOTHING`, [accountId, partnerId]);
    return (await client.query<{ identifier: string }>(`SELECT identifier FROM public.partner_pairwise_ids
      WHERE account_id = $1 AND partner_id = $2`, [accountId, partnerId])).rows[0]!.identifier;
  }
}
