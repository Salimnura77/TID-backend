import type { SqlExecutor } from "../database/sql-executor";
import { randomUUID } from "node:crypto";
import { newPartnerKey } from "./partner-key";
import { canonicalPermissions, PARTNER_PERMISSIONS } from "./partner-permission";
import type { PartnerPermission } from "./partner-permission";
import { appendPartnerCredentialEvent } from "../audit/partner-credential-event";

interface CredentialRecord extends Record<string, unknown> {
  id: string; partner_id: string; permissions: PartnerPermission[]; revoked_at: Date | null;
}
function requireUuid(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error("Invalid partner reference.");
}
async function lockPartner(client: SqlExecutor, id: string, active: boolean) {
  requireUuid(id);
  const row = (await client.query<{ name: string; status: string }>("SELECT name, status FROM public.partner_clients WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!row || (active && row.status !== "active")) throw new Error("Partner is absent or disabled.");
  return row;
}
async function readCredential(client: SqlExecutor, partnerId: string, credentialId: string) {
  requireUuid(credentialId);
  const row = (await client.query<CredentialRecord>(`SELECT id, partner_id, permissions, revoked_at
    FROM public.partner_api_credentials WHERE partner_id = $1 AND id = $2 FOR UPDATE`, [partnerId, credentialId])).rows[0];
  if (!row) throw new Error("Partner credential is absent.");
  return row;
}
async function createCredential(client: SqlExecutor, id: string, name: string, permissions: readonly PartnerPermission[], previousCredentialId?: string) {
  const canonical = canonicalPermissions(permissions);
  const key = newPartnerKey(id);
  const row = (await client.query<{ id: string }>(`INSERT INTO public.partner_api_credentials (partner_id, key_digest, permissions)
    VALUES ($1, $2, $3) RETURNING id`, [id, key.keyDigest, canonical])).rows[0]!;
  await appendPartnerCredentialEvent(client, id, row.id, previousCredentialId ? "credential_rotated" : "credential_created", previousCredentialId);
  return { id, name, credentialId: row.id, permissions: canonical, apiKey: key.key };
}
async function revoke(client: SqlExecutor, record: CredentialRecord) {
  if (record.revoked_at) return;
  await client.query("UPDATE public.partner_api_credentials SET revoked_at = clock_timestamp() WHERE id = $1 AND partner_id = $2", [record.id, record.partner_id]);
  await appendPartnerCredentialEvent(client, record.partner_id, record.id, "credential_revoked");
}

// Operator-only helper, never an HTTP registration route or a runtime seed.
// The caller supplies a transaction and persists the secret outside logs/source.
export async function provisionPartner(client: SqlExecutor, name: string, permissions: readonly PartnerPermission[] = PARTNER_PERMISSIONS) {
  if (name.length < 1 || name.length > 80 || name.trim() !== name || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Invalid partner name.");
  const id = randomUUID();
  canonicalPermissions(permissions);
  await client.query("INSERT INTO public.partner_clients (id, name) VALUES ($1, $2)", [id, name]);
  return createCredential(client, id, name, permissions);
}

// All lifecycle operations require the caller's transaction. Partner locking also
// serializes them against request/disclosure reauthorization and prevents key races.
export async function rotatePartnerCredential(client: SqlExecutor, partnerId: string, expectedCredentialId: string,
  permissions?: readonly PartnerPermission[]) {
  const partner = await lockPartner(client, partnerId, true);
  const old = await readCredential(client, partnerId, expectedCredentialId);
  const nextPermissions = canonicalPermissions(permissions ?? old.permissions);
  if (nextPermissions.some((value) => !old.permissions.includes(value))) throw new Error("Rotation cannot widen permissions.");
  const active = (await client.query<{ id: string }>("SELECT id FROM public.partner_api_credentials WHERE partner_id = $1 AND revoked_at IS NULL", [partnerId])).rows[0];
  if (active && active.id !== old.id) throw new Error("Stale partner credential reference.");
  // A revoked credential may be replaced only when no other credential is active.
  // This creates a new ID/secret; the old reference never becomes active again.
  await revoke(client, old);
  return createCredential(client, partnerId, partner.name, nextPermissions, old.id);
}
export async function revokePartnerCredential(client: SqlExecutor, partnerId: string, credentialId: string): Promise<void> {
  await lockPartner(client, partnerId, false);
  await revoke(client, await readCredential(client, partnerId, credentialId));
}

export async function listPartnerCredentials(client: SqlExecutor, partnerId: string) {
  await lockPartner(client, partnerId, false);
  const rows = (await client.query<{ id: string; permissions: PartnerPermission[]; created_at: Date; revoked_at: Date | null }>(
    "SELECT id, permissions, created_at, revoked_at FROM public.partner_api_credentials WHERE partner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100", [partnerId])).rows;
  return rows.map((row) => ({ credentialId: row.id, permissions: row.permissions,
    createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null }));
}

export async function disablePartner(client: SqlExecutor, id: string): Promise<void> {
  const partner = await lockPartner(client, id, false);
  if (partner.status === "active") await client.query("UPDATE public.partner_clients SET status = 'disabled', disabled_at = clock_timestamp() WHERE id = $1", [id]);
  const rows = (await client.query<CredentialRecord>("SELECT id, partner_id, permissions, revoked_at FROM public.partner_api_credentials WHERE partner_id = $1 AND revoked_at IS NULL FOR UPDATE", [id])).rows;
  for (const row of rows) await revoke(client, row);
}
