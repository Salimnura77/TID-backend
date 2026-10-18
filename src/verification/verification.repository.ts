import { Inject, Injectable } from "@nestjs/common";
import type { SqlExecutor } from "../database/sql-executor";
import { AuditService } from "../audit/audit.service";
import { ApiError } from "../http/api-error";
import type { VerificationOutcome, VerificationResult } from "./verification.provider";

interface AttemptRow extends Record<string, unknown> {
  id: string; outcome: VerificationOutcome | "in_progress"; reason: string | null;
  started_at: Date; completed_at: Date | null;
}
export interface VerificationView {
  readonly id: string;
  readonly provider: "qoreid";
  readonly route: "nin";
  readonly environment: "sandbox";
  readonly outcome: VerificationOutcome | "in_progress";
  readonly reason: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}
const columns = "id, outcome, reason, started_at, completed_at";
function view(row: AttemptRow): VerificationView {
  return { id: row.id, provider: "qoreid", route: "nin", environment: "sandbox", outcome: row.outcome, reason: row.reason,
    startedAt: row.started_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null };
}

@Injectable()
export class VerificationRepository {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async expireStale(client: SqlExecutor, accountId: string): Promise<void> {
    const { rows } = await client.query<AttemptRow>(`UPDATE public.verification_attempts
      SET outcome = 'timeout', reason = 'submission_timeout', completed_at = clock_timestamp()
      WHERE account_id = $1 AND outcome = 'in_progress' AND deadline_at <= clock_timestamp()
      RETURNING ${columns}`, [accountId]);
    for (const row of rows) await this.audit.verificationState(client, accountId, row.id, "timeout");
  }

  async claim(client: SqlExecutor, accountId: string, submissionKey: string): Promise<{ attempt: VerificationView; claimed: boolean }> {
    await this.expireStale(client, accountId);
    const existing = await client.query<AttemptRow>(`SELECT ${columns} FROM public.verification_attempts
      WHERE account_id = $1 AND submission_key = $2`, [accountId, submissionKey]);
    if (existing.rows[0]) return { attempt: view(existing.rows[0]), claimed: false };
    const active = await client.query("SELECT id FROM public.verification_attempts WHERE account_id = $1 AND outcome = 'in_progress'", [accountId]);
    if (active.rows.length) throw new ApiError(409, "verification_in_progress");
    const created = (await client.query<AttemptRow>(`INSERT INTO public.verification_attempts (account_id, submission_key)
      VALUES ($1, $2) RETURNING ${columns}`, [accountId, submissionKey])).rows[0]!;
    await this.audit.verificationState(client, accountId, created.id, "in_progress");
    return { attempt: view(created), claimed: true };
  }

  async complete(client: SqlExecutor, accountId: string, id: string, result: VerificationResult): Promise<VerificationView> {
    await this.expireStale(client, accountId);
    const { rows } = await client.query<AttemptRow>(`UPDATE public.verification_attempts
      SET outcome = $3, reason = $4, completed_at = clock_timestamp()
      WHERE account_id = $1 AND id = $2 AND outcome = 'in_progress' RETURNING ${columns}`,
    [accountId, id, result.outcome, result.reason]);
    if (!rows[0]) return this.read(client, accountId, id);
    await this.audit.verificationState(client, accountId, id, result.outcome);
    return view(rows[0]);
  }

  async read(client: SqlExecutor, accountId: string, id: string): Promise<VerificationView> {
    const { rows } = await client.query<AttemptRow>(`SELECT ${columns} FROM public.verification_attempts WHERE account_id = $1 AND id = $2`, [accountId, id]);
    if (!rows[0]) throw new ApiError(404, "not_found");
    return view(rows[0]);
  }
}
