import { Injectable } from "@nestjs/common";
import type { SqlExecutor } from "../database/sql-executor";
import { ApiError } from "../http/api-error";

@Injectable()
export class VerifiedOutcomeService {
  // Called only inside an active-account transaction. Credentials receives no
  // provider response and never reaches into Verification's private repository.
  async requireLatestVerified(client: SqlExecutor, accountId: string, id: string): Promise<void> {
    const { rows } = await client.query<{ id: string; outcome: string }>(`SELECT id, outcome FROM public.verification_attempts
      WHERE account_id = $1 AND id = $2`, [accountId, id]);
    if (!rows[0]) throw new ApiError(404, "not_found");
    if (rows[0].outcome !== "verified") throw new ApiError(409, "verification_not_verified");
    const latest = await client.query<{ id: string }>(`SELECT id FROM public.verification_attempts
      WHERE account_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`, [accountId]);
    if (latest.rows[0]?.id !== id) throw new ApiError(409, "verification_not_current");
  }
}
