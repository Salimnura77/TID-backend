import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SqlExecutor, SqlRow } from "./sql-executor";

export interface Migration {
  readonly id: string;
  readonly checksum: string;
  readonly sql: string;
}
interface AppliedMigration extends SqlRow { id: string; checksum: string }

export async function loadMigrations(directory = resolve("migrations")): Promise<readonly Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (!names.length || names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) ||
      new Set(names.map((name) => name.slice(0, 3))).size !== names.length) {
    throw new Error("Invalid migration directory.");
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(resolve(directory, name), "utf8");
    return { id: name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

async function appliedCount(client: SqlExecutor, migrations: readonly Migration[]): Promise<number> {
  const { rows } = await client.query<AppliedMigration>(
    "SELECT id, checksum FROM public.schema_migrations ORDER BY id",
  );
  if (rows.some((row, index) =>
    row.id !== migrations[index]?.id || row.checksum !== migrations[index]?.checksum,
  )) throw new Error("Migration history does not match this service.");
  return rows.length;
}

export async function assertSchemaCurrent(client: SqlExecutor, migrations: readonly Migration[]): Promise<void> {
  if (await appliedCount(client, migrations) !== migrations.length) {
    throw new Error("Database migrations are pending.");
  }
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.accounts') IS NOT NULL AND to_regclass('public.account_identities') IS NOT NULL AND to_regclass('public.verification_attempts') IS NOT NULL AND to_regclass('public.audit_events') IS NOT NULL AND to_regclass('public.credentials') IS NOT NULL AND to_regclass('public.credential_signing_keys') IS NOT NULL AND to_regclass('public.credential_audit_events') IS NOT NULL AND to_regclass('public.partner_clients') IS NOT NULL AND to_regclass('public.partner_pairwise_ids') IS NOT NULL AND to_regclass('public.consent_invitations') IS NOT NULL AND to_regclass('public.consent_requests') IS NOT NULL AND to_regclass('public.consent_audit_events') IS NOT NULL AND to_regclass('public.partner_api_credentials') IS NOT NULL AND to_regclass('public.partner_credential_audit_events') IS NOT NULL AS exists",
  );
  if (!rows[0]?.exists) throw new Error("Account schema is unavailable.");
}

export async function applyMigrations(client: SqlExecutor, migrations: readonly Migration[]): Promise<number> {
  await client.query("BEGIN");
  try {
    // Every migrator must use this lock on the same connection and transaction.
    await client.query("SELECT pg_advisory_xact_lock(847291, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const count = await appliedCount(client, migrations);
    for (const migration of migrations.slice(count)) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO public.schema_migrations (id, checksum) VALUES ($1, $2)",
        [migration.id, migration.checksum],
      );
    }
    await client.query("COMMIT");
    return migrations.length - count;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Caller discards the connection on failure. */ }
    throw error;
  }
}
