import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWSHeaderParameters } from "jose";
import { readConfig } from "../src/config/runtime-config";
import { applyMigrations, assertSchemaCurrent, loadMigrations } from "../src/database/migrations";
import type { SqlExecutor, SqlRow } from "../src/database/sql-executor";

// Technical test identifiers and keys exist only in memory; no identity profiles or seeds.
export async function cryptoFixture() {
  const config = readConfig({
    NODE_ENV: "test", DATABASE_URL: `postgresql://${randomUUID()}:${randomUUID()}@localhost/trueid`,
    TRUEID_AUTH0_TENANT_MODE: "sandbox",
    TRUEID_AUTH0_ISSUER: `https://${randomUUID()}.auth0.com/`,
    TRUEID_AUTH0_AUDIENCE: `urn:trueid:test:${randomUUID()}`,
    TRUEID_AUTH0_MOBILE_CLIENT_ID: randomUUID(),
  });
  const pair = await generateKeyPair("RS256", { extractable: true });
  const kid = randomUUID();
  const jwk = { ...await exportJWK(pair.publicKey), kid, alg: "RS256", use: "sig" };
  const key = createLocalJWKSet({ keys: [jwk] });
  async function token(subject: string, overrides: Record<string, unknown> = {}, header: Partial<JWSHeaderParameters> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: config.auth0!.issuer, sub: subject, aud: config.auth0!.audience,
      iat: now, exp: now + 300, jti: randomUUID(), client_id: config.auth0!.mobileClientId,
      scope: "openid account:self", ...overrides,
    }).setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid, ...header }).sign(pair.privateKey);
  }
  return { config, key, token, pair };
}

function executor(db: Pick<PGlite, "exec" | "query">): SqlExecutor {
  return { async query<Row extends SqlRow>(sql: string, values?: unknown[]) {
    if (values) return db.query<Row>(sql, values);
    const results = await db.exec(sql);
    return { rows: (results.at(-1)?.rows ?? []) as Row[] };
  } };
}

export class EmbeddedDatabase {
  readonly db = new PGlite();
  async initialize(): Promise<void> { await applyMigrations(executor(this.db), await loadMigrations()); }
  async assertReady(): Promise<void> { await assertSchemaCurrent(executor(this.db), await loadMigrations()); }
  async withClient<T>(work: (client: SqlExecutor) => Promise<T>): Promise<T> { return work(executor(this.db)); }
  async transaction<T>(work: (client: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(executor(tx)));
  }
  async close(): Promise<void> { await this.db.close(); }
}
