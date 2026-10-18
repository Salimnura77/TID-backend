import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, assertSchemaCurrent, loadMigrations } from "../src/database/migrations";
import type { SqlExecutor, SqlRow } from "../src/database/sql-executor";
import { newPartnerKey } from "../src/partners/partner-key";

// PGlite runs the PostgreSQL engine in WASM. Runtime connections use pg, never this adapter.
function executor(db: PGlite): SqlExecutor {
  return {
    async query<Row extends SqlRow>(sql: string, values?: unknown[]) {
      if (values) return db.query<Row>(sql, values);
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
  };
}

test("PostgreSQL migration and account invariants", async (t) => {
  const db = new PGlite();
  const client = executor(db);
  const migrations = await loadMigrations();
  try {
    await t.test("readiness denies an unmigrated database; migration is repeatable", async () => {
      await assert.rejects(assertSchemaCurrent(client, migrations));
      assert.equal(await applyMigrations(client, migrations), 6);
      assert.equal(await applyMigrations(client, migrations), 0);
      await assertSchemaCurrent(client, migrations);
    });

    await t.test("internal account IDs are distinct random UUIDs; invalid lifecycle states fail", async () => {
      const one = await db.query<{ id: string }>("INSERT INTO public.accounts DEFAULT VALUES RETURNING id");
      const two = await db.query<{ id: string }>("INSERT INTO public.accounts DEFAULT VALUES RETURNING id");
      const id = one.rows[0]!.id;
      assert.match(id, /^[a-f0-9-]{14}4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.notEqual(id, two.rows[0]!.id);
      await assert.rejects(db.query("INSERT INTO public.accounts (id) VALUES ($1)", [id]));
      await assert.rejects(db.query("INSERT INTO public.accounts (id) VALUES ('00000000-0000-0000-0000-000000000000')"));
      await assert.rejects(db.query("UPDATE public.accounts SET status = 'verified' WHERE id = $1", [id]));
      await assert.rejects(db.query("UPDATE public.accounts SET status = 'disabled' WHERE id = $1", [id]));
      await assert.rejects(db.query("UPDATE public.accounts SET disabled_at = CURRENT_TIMESTAMP WHERE id = $1", [id]));
      await assert.rejects(db.query("UPDATE public.accounts SET status = 'disabled', disabled_at = created_at - INTERVAL '1 second' WHERE id = $1", [id]));
      await db.query("UPDATE public.accounts SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
      const result = await db.query<{ status: string; valid: boolean }>(
        "SELECT status, updated_at >= created_at AS valid FROM public.accounts WHERE id = $1", [id],
      );
      assert.equal(result.rows[0]!.status, "disabled");
      assert.equal(result.rows[0]!.valid, true);
    });

    await t.test("edited migration history and a service behind the database are rejected", async () => {
      const changed = migrations.map((migration) => ({ ...migration, checksum: "0".repeat(64) }));
      await assert.rejects(applyMigrations(client, changed), /Migration history/);
      await assert.rejects(assertSchemaCurrent(client, changed), /Migration history/);
      await assert.rejects(applyMigrations(client, []), /Migration history/);
      await assertSchemaCurrent(client, migrations);
    });

    await t.test("a failed later migration rolls back both DDL and its ledger entry", async () => {
      const sql = "CREATE TABLE public.must_rollback (id integer); SELECT missing_column FROM public.accounts;";
      const next = { id: "007_failure.sql", sql, checksum: createHash("sha256").update(sql).digest("hex") };
      await assert.rejects(assertSchemaCurrent(client, [...migrations, next]), /pending/);
      await assert.rejects(applyMigrations(client, [...migrations, next]));
      const rolledBack = await db.query<{ object: string | null }>("SELECT to_regclass('public.must_rollback')::text AS object");
      assert.equal(rolledBack.rows[0]!.object, null);
      const ledger = await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.schema_migrations");
      assert.equal(ledger.rows[0]!.count, 6);
      await assertSchemaCurrent(client, migrations);
    });
  } finally { await db.close(); }
});

test("credential migration preserves existing pilot keys and pairwise identities without reactivating disabled clients", async () => {
  const db = new PGlite();
  const client = executor(db);
  const migrations = await loadMigrations();
  try {
    await applyMigrations(client, migrations.slice(0, 5));
    const active = newPartnerKey();
    const disabled = newPartnerKey();
    for (const partner of [active, disabled]) await db.query("INSERT INTO public.partner_clients (id, name, key_digest) VALUES ($1, $2, $3)", [partner.id, `Integration ${randomUUID()}`, partner.keyDigest]);
    await db.query("UPDATE public.partner_clients SET status = 'disabled', disabled_at = clock_timestamp() WHERE id = $1", [disabled.id]);
    const accountId = (await db.query<{ id: string }>("INSERT INTO public.accounts DEFAULT VALUES RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO public.partner_pairwise_ids (account_id, partner_id) VALUES ($1, $2)", [accountId, active.id]);
    const before = (await db.query("SELECT * FROM public.partner_pairwise_ids")).rows;
    assert.equal(await applyMigrations(client, migrations), 1);
    assert.equal(await applyMigrations(client, migrations), 0);
    await assertSchemaCurrent(client, migrations);
    assert.deepEqual((await db.query("SELECT * FROM public.partner_pairwise_ids")).rows, before);
    const credentials = (await db.query<{ id: string; partner_id: string; key_digest: string; permissions: string[]; revoked_at: Date | null }>("SELECT id, partner_id, key_digest, permissions, revoked_at FROM public.partner_api_credentials")).rows;
    assert.equal(credentials.length, 2);
    const current = credentials.find((row) => row.partner_id === active.id)!;
    assert.equal(current.key_digest, active.keyDigest);
    assert.equal(current.revoked_at, null);
    assert.deepEqual(current.permissions, ["disclosures:create", "requests:create", "requests:read"]);
    const retired = credentials.find((row) => row.partner_id === disabled.id)!;
    assert.equal(retired.key_digest, disabled.keyDigest);
    assert(retired.revoked_at instanceof Date);
    await assert.rejects(db.query("UPDATE public.partner_api_credentials SET revoked_at = NULL WHERE id = $1", [retired.id]));
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'partner_clients' AND column_name = 'key_digest'")).rows;
    assert.equal(columns.length, 0);
    const audit = (await db.query<{ event: string }>("SELECT * FROM public.partner_credential_audit_events")).rows;
    assert.equal(audit.length, 2);
    assert(audit.every((row) => row.event === "credential_migrated"));
    for (const value of [active.key, disabled.key, active.keyDigest, disabled.keyDigest]) assert.equal(JSON.stringify(audit).includes(value), false);
  } finally { await db.close(); }
});
