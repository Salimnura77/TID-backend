import { Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedIdentity } from "../auth/identity";
import { DatabaseService } from "../database/database.service";
import type { SqlExecutor, SqlRow } from "../database/sql-executor";
import { ApiError } from "../http/api-error";

interface AccountRow extends SqlRow { id: string; status: "active" | "disabled"; created_at: Date; updated_at: Date }
export interface AccountView { readonly id: string; readonly status: "active"; readonly createdAt: string; readonly updatedAt: string }

const ownedAccount = `SELECT a.id, a.status, a.created_at, a.updated_at
  FROM public.accounts a JOIN public.account_identities i ON i.account_id = a.id
  WHERE i.issuer = $1 AND i.subject = $2`;

function view(row: AccountRow): AccountView {
  if (row.status !== "active") throw new ApiError(403, "forbidden");
  return { id: row.id, status: "active", createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

@Injectable()
export class AccountRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async readOwn(identity: AuthenticatedIdentity): Promise<AccountView> {
    return this.database.withClient(async (client) => {
      const { rows } = await client.query<AccountRow>(ownedAccount, [identity.issuer, identity.subject]);
      if (!rows[0]) throw new ApiError(404, "not_found");
      return view(rows[0]);
    });
  }

  async createOrResume(identity: AuthenticatedIdentity): Promise<{ account: AccountView; created: boolean }> {
    return this.database.transaction(async (client: SqlExecutor) => {
      const values = [identity.issuer, identity.subject];
      // Unique binding + transaction prevent duplicate accounts during simultaneous sign-ins.
      const candidate = (await client.query<AccountRow>("INSERT INTO public.accounts DEFAULT VALUES RETURNING id, status, created_at, updated_at")).rows[0]!;
      const binding = await client.query(`INSERT INTO public.account_identities (issuer, subject, account_id)
        VALUES ($1, $2, $3) ON CONFLICT (issuer, subject) DO NOTHING RETURNING account_id`, [...values, candidate.id]);
      const created = binding.rows.length === 1;
      if (!created) await client.query("DELETE FROM public.accounts WHERE id = $1", [candidate.id]);
      const result = await client.query<AccountRow>(`${ownedAccount} FOR UPDATE OF a`, values);
      if (!result.rows[0]) throw new ApiError(503, "service_unavailable");
      return { account: view(result.rows[0]), created };
    });
  }
}
