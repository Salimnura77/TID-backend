import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPool } from "../src/database/pool";
import { executorFor } from "../src/database/sql-executor";
import { applyMigrations, assertSchemaCurrent, loadMigrations } from "../src/database/migrations";
import { DatabaseService } from "../src/database/database.service";
import { StructuredLogger } from "../src/logging/structured-logger";
import { AccountRepository } from "../src/users/account.repository";
import { PartnersService } from "../src/partners/partners.service";
import { provisionPartner, rotatePartnerCredential } from "../src/partners/provision-partner";
import { postgresTestSettings } from "./postgres-support";

test("TCP PostgreSQL migrations, pooled concurrency and partner revocation", { timeout: 60000 }, async (t) => {
  const settings = postgresTestSettings(process.env); // Explicit command fails, never silently skips.
  const logger = new StructuredLogger("error", undefined, () => undefined);
  const admin = createPool(settings.admin, logger);
  const pool = createPool(settings.isolated, logger);
  const database = new DatabaseService(settings.isolated, logger);
  let created = false;
  try {
    try { await admin.query(`CREATE DATABASE "${settings.databaseName}"`); created = true; }
    catch { throw new Error("Cannot create isolated TCP test database; check local PostgreSQL and the CI role's CREATEDB permission."); }
    const migrations = await loadMigrations();
    await database.onModuleInit();
    await t.test("two real migrators serialize on the advisory lock and apply each migration once", async () => {
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await assert.rejects(assertSchemaCurrent(executorFor(first), migrations));
        const counts = await Promise.all([applyMigrations(executorFor(first), migrations), applyMigrations(executorFor(second), migrations)]);
        assert.deepEqual(counts.sort((a, b) => a - b), [0, migrations.length]);
        await database.assertReady();
        const row = (await first.query("SELECT current_setting('TimeZone') AS zone")).rows[0];
        assert.equal(row.zone, "UTC");
      } finally { first.release(); second.release(); }
    });
    await t.test("failed DDL and a changed migration checksum leave the database current", async () => {
      const client = await pool.connect();
      try {
        const sql = "CREATE TABLE public.ci_rollback_probe(id integer); SELECT absent_ci_column FROM public.accounts;";
        const next = { id: "999_ci_failure.sql", sql, checksum: createHash("sha256").update(sql).digest("hex") };
        await assert.rejects(applyMigrations(executorFor(client), [...migrations, next]));
        assert.equal((await client.query("SELECT to_regclass('public.ci_rollback_probe') AS relation")).rows[0].relation, null);
        await assert.rejects(applyMigrations(executorFor(client), migrations.map((item) => ({ ...item, checksum: "0".repeat(64) }))));
        await database.assertReady();
      } finally { client.release(); }
    });
    await t.test("simultaneous resumption produces one binding and no orphan accounts", async () => {
      const accounts = new AccountRepository(database);
      const identity = { issuer: `https://${randomUUID()}.example.invalid/`, subject: randomUUID() };
      const results = await Promise.all(Array.from({ length: 10 }, () => accounts.createOrResume(identity)));
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(new Set(results.map((result) => result.account.id)).size, 1);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM public.accounts")).rows[0].count, 1);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM public.account_identities")).rows[0].count, 1);
      await assert.rejects(accounts.readOwn({ ...identity, subject: randomUUID() }));
    });
    await t.test("competing rotations commit one replacement; a previously authenticated key is denied", async () => {
      const partners = new PartnersService(database);
      const original = await database.transaction((client) => provisionPartner(client, `CI ${randomUUID()}`));
      const authenticated = await partners.authenticate(original.apiKey, "requests:read");
      const outcomes = await Promise.allSettled(Array.from({ length: 2 }, () => database.transaction((client) =>
        rotatePartnerCredential(client, original.id, original.credentialId))));
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
      await assert.rejects(partners.authenticate(original.apiKey, "requests:read"));
      await assert.rejects(database.transaction((client) => partners.requireAuthenticated(client, authenticated, "requests:read")));
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM public.partner_api_credentials WHERE partner_id = $1 AND revoked_at IS NULL", [original.id])).rows[0].count, 1);
    });
  } finally {
    await database.onModuleDestroy();
    await pool.end();
    try {
      // Only the internally generated name created by this invocation is dropped.
      if (created) await admin.query(`DROP DATABASE "${settings.databaseName}"`);
    } finally { await admin.end(); }
  }
});
