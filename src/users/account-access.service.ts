import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedIdentity } from "../auth/identity";
import type { SqlExecutor } from "../database/sql-executor";
import { ApiError } from "../http/api-error";
import { DatabaseService } from "../database/database.service";

// The exported domain boundary resolves ownership and locks account lifecycle
// during a caller's short transaction. Other modules never query Users tables.
@Injectable()
export class AccountAccessService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async requireActive(identity: AuthenticatedIdentity, client?: SqlExecutor): Promise<string> {
    if (!client) return this.database.transaction((tx) => this.requireActive(identity, tx));
    const { rows } = await client.query<{ id: string; status: string }>(`SELECT a.id, a.status
      FROM public.accounts a JOIN public.account_identities i ON i.account_id = a.id
      WHERE i.issuer = $1 AND i.subject = $2 FOR UPDATE OF a`, [identity.issuer, identity.subject]);
    if (!rows[0]) throw new ApiError(404, "not_found");
    if (rows[0].status !== "active") throw new ApiError(403, "forbidden");
    return rows[0].id;
  }

  // Only server-owned references resolved by another domain may use this method.
  // Never accepts a caller-selected account ID from a partner's HTTP input.
  async requireActiveReference(client: SqlExecutor, accountId: string): Promise<void> {
    const row = (await client.query<{ status: string }>(
      "SELECT status FROM public.accounts WHERE id = $1 FOR UPDATE", [accountId])).rows[0];
    if (!row || row.status !== "active") throw new ApiError(403, "forbidden");
  }
}
