import { Injectable } from "@nestjs/common";
import type { SqlExecutor } from "../database/sql-executor";
import type { VerificationOutcome } from "../verification/verification.provider";
import { ApiError } from "../http/api-error";

interface ConsentAuditRecord extends Record<string, unknown> {
  id: string; request_id: string; partner_id: string; event: string; revision: number; occurred_at: Date;
}

@Injectable()
export class AuditService {
  async consentState(client: SqlExecutor, accountId: string, partnerId: string, requestId: string, revision: number,
    event: "request_created" | "consent_approved" | "consent_declined" | "consent_revoked" | "attributes_disclosed", partnerCredentialId?: string): Promise<void> {
    await client.query(`INSERT INTO public.consent_audit_events (account_id, partner_id, request_id, revision, event, partner_credential_id)
      VALUES ($1, $2, $3, $4, $5, $6)`, [accountId, partnerId, requestId, revision, event, partnerCredentialId ?? null]);
  }
  // Caller first authorizes an owned request and holds the account lifecycle lock.
  // Cursor is a scoped event reference; SQL keeps full timestamp precision when
  // comparing rows, independently of JavaScript Date's millisecond representation.
  async consentHistory(client: SqlExecutor, accountId: string, requestId: string, cursor?: string) {
    if (cursor) {
      const anchor = (await client.query("SELECT id FROM public.consent_audit_events WHERE account_id = $1 AND request_id = $2 AND id = $3", [accountId, requestId, cursor])).rows[0];
      if (!anchor) throw new ApiError(400, "invalid_request");
    }
    const { rows } = await client.query<ConsentAuditRecord>(`SELECT id, request_id, partner_id, event, revision, occurred_at
      FROM public.consent_audit_events WHERE account_id = $1 AND request_id = $2
      ${cursor ? `AND (occurred_at, id) < (SELECT occurred_at, id FROM public.consent_audit_events
        WHERE account_id = $1 AND request_id = $2 AND id = $3)` : ""}
      ORDER BY occurred_at DESC, id DESC LIMIT 51`, cursor ? [accountId, requestId, cursor] : [accountId, requestId]);
    const page = rows.slice(0, 50);
    return { events: page.map((row) => ({ id: row.id, requestId: row.request_id, partnerId: row.partner_id,
      event: row.event, actor: row.event === "request_created" || row.event === "attributes_disclosed" ? "partner" : "user",
      revision: row.revision, occurredAt: row.occurred_at.toISOString() })),
    nextCursor: rows.length > 50 ? page.at(-1)!.id : null };
  }
  async credentialState(client: SqlExecutor, accountId: string, credentialId: string,
    event: "credential_issued" | "credential_revoked" | "credential_superseded"): Promise<void> {
    await client.query(`INSERT INTO public.credential_audit_events (account_id, credential_id, event)
      VALUES ($1, $2, $3)`, [accountId, credentialId, event]);
  }
  // Fixed metadata only; the caller supplies its state transaction. No operational
  // logging, request payload, provider response, identity input or token argument.
  async verificationState(client: SqlExecutor, accountId: string, verificationId: string, outcome: VerificationOutcome | "in_progress"): Promise<void> {
    await client.query(`INSERT INTO public.audit_events (account_id, verification_id, event, outcome)
      VALUES ($1, $2, $3, $4)`, [accountId, verificationId,
      outcome === "in_progress" ? "verification_submitted" : "verification_completed", outcome]);
  }
}
