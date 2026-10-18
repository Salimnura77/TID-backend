import "reflect-metadata";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { decodeJwt } from "jose";
import supertest from "supertest";
import { AppModule } from "../src/app.module";
import { ACCESS_TOKEN_VERIFIER } from "../src/auth/identity";
import { Auth0TokenVerifier } from "../src/auth/auth0-token-verifier";
import { APP_CONFIG } from "../src/config/runtime-config";
import { DatabaseService } from "../src/database/database.service";
import { configureHttp } from "../src/http/configure-http";
import { RequestContext } from "../src/logging/request-context";
import { StructuredLogger } from "../src/logging/structured-logger";
import { AuditService } from "../src/audit/audit.service";
import { CREDENTIAL_CLOCK } from "../src/credentials/credential";
import { SIGNING_KEYS } from "../src/credentials/signing-key";
import type { SigningKey, SigningKeys } from "../src/credentials/signing-key";
import { TestSigningKey } from "../src/credentials/test-signing-keys";
import { VERIFICATION_PROVIDER } from "../src/verification/verification.provider";
import type { VerificationResult } from "../src/verification/verification.provider";
import { cryptoFixture, EmbeddedDatabase } from "./auth-support";

test("credential issuance, validation and lifecycle require owned verified outcomes", { timeout: 60000 }, async (t) => {
  const fixture = await cryptoFixture();
  const database = new EmbeddedDatabase();
  await database.initialize();
  const logs: string[] = [];
  let now = new Date();
  let signingEnabled = true;
  const versions = new Map<string, SigningKey>();
  const makeKey = () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = new TestSigningKey(`test-${randomUUID()}`, pair.privateKey);
    versions.set(key.id, key);
    return key;
  };
  let active = makeKey();
  let signHook: ((key: SigningKey, bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>) | undefined;
  const decorate = (key: SigningKey): SigningKey => ({ id: key.id, mode: key.mode, algorithm: key.algorithm,
    publicKey: () => key.publicKey(), sign: (bytes, signal) => signHook ? signHook(key, bytes, signal) : key.sign(bytes, signal) });
  const ring: SigningKeys = { get mode() { return signingEnabled ? "test" : "disabled"; },
    active: async () => decorate(active), version: async (id) => { const key = versions.get(id); assert(key); return decorate(key); } };
  let outcome: VerificationResult = { outcome: "verified", reason: "exact_match" };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(fixture.config)
    .overrideProvider(DatabaseService).useValue(database)
    .overrideProvider(ACCESS_TOKEN_VERIFIER).useValue(new Auth0TokenVerifier(fixture.config.auth0, fixture.key))
    .overrideProvider(VERIFICATION_PROVIDER).useValue({ available: true, verify: async () => outcome })
    .overrideProvider(SIGNING_KEYS).useValue(ring)
    .overrideProvider(CREDENTIAL_CLOCK).useValue({ now: () => new Date(now) })
    .overrideProvider(StructuredLogger).useFactory({ inject: [RequestContext], factory: (context: RequestContext) => new StructuredLogger("debug", context, (line) => logs.push(line)) })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureHttp(app, fixture.config);
  await app.init();
  const request = supertest(app.getHttpServer());
  const tokenA = await fixture.token(randomUUID());
  const tokenB = await fixture.token(randomUUID());
  const accountA = (await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({}).expect(200)).body.account.id as string;
  await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).send({}).expect(200);
  const verify = async (token: string = tokenA) => {
    const result = await request.post("/api/v1/verifications").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID())
      .send({ nin: "63184876213", firstname: "Bunch", lastname: "Dillon" }).expect(200);
    return result.body.verification.id as string;
  };
  const issue = (id: string, token: string = tokenA) => request.post("/api/v1/credentials").set("Authorization", `Bearer ${token}`).send({ verificationId: id });
  const check = (credential: string, token: string = tokenA) => request.post("/api/v1/credentials/check").set("Authorization", `Bearer ${token}`).send({ credential });
  const status = (id: string, token: string = tokenA) => request.get(`/api/v1/credentials/${id}/status`).set("Authorization", `Bearer ${token}`);
  const revoke = (id: string, token: string = tokenA) => request.post(`/api/v1/credentials/${id}/revoke`).set("Authorization", `Bearer ${token}`).send({});
  const credentialCount = async () => (await database.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.credentials")).rows[0]!.count;
  const signatures: string[] = [];
  let verificationA = "";
  let credentialA = "";
  let signedA = "";
  let latestCredential = "";
  let latestSigned = "";
  try {
    await t.test("credentials are protected by default and require minimum validated input", async () => {
      await request.post("/api/v1/credentials").send({ verificationId: randomUUID() }).expect(401);
      await request.post("/api/v1/credentials/check").send({ credential: randomUUID() }).expect(401);
      await request.get(`/api/v1/credentials/${randomUUID()}/status`).expect(401);
      await request.post(`/api/v1/credentials/${randomUUID()}/revoke`).send({}).expect(401);
      await issue(randomUUID()).expect(404);
      await request.post("/api/v1/credentials").set("Authorization", `Bearer ${tokenA}`).send({ verificationId: randomUUID(), accountId: accountA }).expect(400);
      await request.post("/api/v1/credentials/check").set("Authorization", `Bearer ${tokenA}`).send({ credential: "x".repeat(4097) }).expect(400);
      assert.equal(await credentialCount(), 0);
    });

    await t.test("all non-verified outcomes deny issuance and the database rejects forged verified references", async () => {
      const keyId = active.id;
      await database.db.query("INSERT INTO public.credential_signing_keys (id, algorithm, public_key) VALUES ($1, 'RS256', $2::jsonb)", [keyId, JSON.stringify(await active.publicKey())]);
      const pending = (await database.db.query<{ id: string }>("INSERT INTO public.verification_attempts (account_id, submission_key) VALUES ($1, $2) RETURNING id", [accountA, randomUUID()])).rows[0]!.id;
      await issue(pending).expect(409);
      await database.db.query("UPDATE public.verification_attempts SET outcome = 'timeout', reason = 'submission_timeout', completed_at = clock_timestamp() WHERE id = $1", [pending]);
      for (const result of [
        { outcome: "needs_review", reason: "partial_match" }, { outcome: "unable_to_verify", reason: "no_match" },
        { outcome: "timeout", reason: "provider_timeout" }, { outcome: "provider_unavailable", reason: "provider_unavailable" },
      ] as const) {
        outcome = result;
        const id = await verify();
        const denied = await issue(id).expect(409);
        assert.equal(denied.body.error.code, "verification_not_verified");
        await assert.rejects(database.db.query(`INSERT INTO public.credentials (id, account_id, verification_id, signing_key_id, issued_at, expires_at)
          VALUES ($1, $2, $3, $4, date_trunc('second', clock_timestamp()), date_trunc('second', clock_timestamp()) + INTERVAL '5 minutes')`, [randomUUID(), accountA, id, keyId]));
      }
      assert.equal(await credentialCount(), 0);
      outcome = { outcome: "verified", reason: "exact_match" };
    });

    await t.test("only a current verified result issues a minimal signed Test credential; concurrent retries resume it", async () => {
      const older = await verify();
      verificationA = await verify();
      await issue(older).expect(409);
      signingEnabled = false;
      await issue(verificationA).expect(503);
      assert.equal(await credentialCount(), 0);
      signingEnabled = true;
      const responses = await Promise.all([issue(verificationA).expect(200), issue(verificationA).expect(200)]);
      assert.equal(responses.filter((r) => r.body.created).length, 1);
      assert.equal(new Set(responses.map((r) => r.body.credential.id)).size, 1);
      assert.equal(new Set(responses.map((r) => r.body.signedCredential)).size, 1);
      credentialA = responses[0]!.body.credential.id;
      signedA = responses[0]!.body.signedCredential;
      signatures.push(signedA);
      assert.equal(responses[0]!.headers["cache-control"], "no-store");
      const claims = decodeJwt(signedA);
      assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "jti", "test", "verification"]);
      assert.equal(claims.test, true);
      for (const value of [accountA, verificationA, "63184876213", "Bunch", "Dillon"]) assert.equal(JSON.stringify(claims).includes(value), false);
      assert.equal((await check(signedA).expect(200)).body.valid, true);
      await request.get("/api/v1/users/me").set("Authorization", `Bearer ${signedA}`).expect(401);
      assert.equal(await credentialCount(), 1);
    });

    await t.test("another account cannot issue, validate, revoke or read the owner's credential", async () => {
      await issue(verificationA, tokenB).expect(404);
      await status(credentialA, tokenB).expect(404);
      await check(signedA, tokenB).expect(404);
      await revoke(credentialA, tokenB).expect(404);
      await status(credentialA).query({ accountId: accountA }).expect(400);
      assert.equal((await status(credentialA).expect(200)).body.credential.status, "active");
    });

    await t.test("tampering, malformed credentials and unknown keys are rejected without exposing payloads", async () => {
      const parts = signedA.split(".");
      const signature = Buffer.from(parts[2]!, "base64url");
      signature[0] = signature[0]! ^ 1;
      const tampered = `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`;
      const response = await check(tampered).expect(400);
      assert.equal(response.body.error.code, "credential_invalid");
      assert.equal(response.text.includes(signedA), false);
      await check(randomUUID()).expect(400);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "trueid-test-credential+jwt", kid: `test-${randomUUID()}` })).toString("base64url");
      await check(`${header}.${parts[1]}.${parts[2]}`).expect(400);
    });

    await t.test("revocation is idempotent and neither reissuance nor database updates can restore the reference", async () => {
      await revoke(credentialA).expect(200);
      await revoke(credentialA).expect(200);
      assert.equal((await check(signedA).expect(200)).body.valid, false);
      assert.equal((await status(credentialA).expect(200)).body.credential.status, "revoked");
      await issue(verificationA).expect(409);
      await assert.rejects(database.db.query("UPDATE public.credentials SET state = 'active', revoked_at = NULL WHERE id = $1", [credentialA]));
      const audit = await database.db.query("SELECT id FROM public.credential_audit_events WHERE credential_id = $1 AND event = 'credential_revoked'", [credentialA]);
      assert.equal(audit.rows.length, 1);
    });

    await t.test("reverification creates a new reference and leaves old grant references and terminal states untouched", async () => {
      // Technical probe only: ConsentModule has no business API in this slice.
      await database.db.exec("CREATE TABLE consent_probe (id uuid PRIMARY KEY, credential_id uuid REFERENCES public.credentials(id), state text NOT NULL)");
      for (const state of ["declined", "revoked"]) await database.db.query("INSERT INTO consent_probe VALUES ($1, $2, $3)", [randomUUID(), credentialA, state]);
      const newer = await verify();
      const fresh = await issue(newer).expect(200);
      assert.notEqual(fresh.body.credential.id, credentialA);
      assert.equal((await status(credentialA).expect(200)).body.credential.status, "revoked");
      const previous = fresh.body.credential.id as string;
      signatures.push(fresh.body.signedCredential);
      await database.db.query("INSERT INTO consent_probe VALUES ($1, $2, 'approved')", [randomUUID(), previous]);
      const grantsBefore = (await database.db.query("SELECT * FROM consent_probe ORDER BY id")).rows;
      const next = await issue(await verify()).expect(200);
      latestCredential = next.body.credential.id;
      latestSigned = next.body.signedCredential;
      signatures.push(latestSigned);
      assert.notEqual(latestCredential, previous);
      assert.equal((await status(previous).expect(200)).body.credential.status, "superseded");
      assert.equal((await check(fresh.body.signedCredential).expect(200)).body.valid, false);
      assert.deepEqual((await database.db.query("SELECT * FROM consent_probe ORDER BY id")).rows, grantsBefore);
      await issue(newer).expect(409);
    });

    await t.test("rotation uses a new kid and retains public verification of retired versions without reopening old credentials", async () => {
      const oldKey = active.id;
      active = makeKey();
      const newer = await issue(await verify()).expect(200);
      assert.equal(newer.body.credential.keyId, active.id);
      assert.notEqual(active.id, oldKey);
      assert.equal((await check(latestSigned).expect(200)).body.credential.status, "superseded");
      assert.equal((await check(newer.body.signedCredential).expect(200)).body.valid, true);
      signatures.push(newer.body.signedCredential);
      latestCredential = newer.body.credential.id;
      latestSigned = newer.body.signedCredential;
      await assert.rejects(database.db.query("UPDATE public.credential_signing_keys SET public_key = '{}'::jsonb WHERE id = $1", [oldKey]));
    });

    await t.test("audit/signing failures leave no partially issued reference or superseded prior credential", async () => {
      const id = await verify();
      const before = await credentialCount();
      const marker = randomUUID();
      signHook = async () => { throw new Error(marker); };
      const unavailable = await issue(id).expect(503);
      assert.equal(unavailable.text.includes(marker), false);
      assert.equal(await credentialCount(), before);
      signHook = undefined;
      const audit = module.get(AuditService);
      const append = audit.credentialState.bind(audit);
      audit.credentialState = async () => { throw new Error(marker); };
      try { await issue(id).expect(500); } finally { audit.credentialState = append; }
      assert.equal(await credentialCount(), before);
      assert.equal((await status(latestCredential).expect(200)).body.credential.status, "active");
      const fresh = await issue(id).expect(200);
      latestCredential = fresh.body.credential.id;
      latestSigned = fresh.body.signedCredential;
      signatures.push(latestSigned);
    });

    await t.test("reverification during signing prevents issuance from the superseded verification result", async () => {
      const id = await verify();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      signHook = async (key, bytes, signal) => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return key.sign(bytes, signal); };
      const pending = issue(id).then((r) => r);
      await started;
      const nextVerification = await verify();
      release();
      assert.equal((await pending).status, 409);
      signHook = undefined;
      const fresh = await issue(nextVerification).expect(200);
      latestCredential = fresh.body.credential.id;
      latestSigned = fresh.body.signedCredential;
      signatures.push(latestSigned);
    });

    await t.test("a signing backend that never settles is aborted without changing current credential status", async () => {
      const id = await verify();
      const before = await credentialCount();
      let aborted = false;
      signHook = async (_key, _bytes, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise(() => undefined);
      };
      try { await issue(id).expect(503); } finally { signHook = undefined; }
      assert.equal(aborted, true);
      assert.equal(await credentialCount(), before);
      assert.equal((await status(latestCredential).expect(200)).body.credential.status, "active");
    });

    await t.test("account disabling during signing denies finalization without inserting a credential", async () => {
      const id = await verify();
      const before = await credentialCount();
      signHook = async (key, bytes, signal) => {
        await database.db.query("UPDATE public.accounts SET status = 'disabled', disabled_at = clock_timestamp() WHERE id = $1", [accountA]);
        return key.sign(bytes, signal);
      };
      try { await issue(id).expect(403); } finally {
        signHook = undefined;
        await database.db.query("UPDATE public.accounts SET status = 'active', disabled_at = NULL WHERE id = $1", [accountA]);
      }
      assert.equal(await credentialCount(), before);
    });

    await t.test("revocation during a resumed signature prevents issuance from reactivating the reference", async () => {
      const fresh = await issue(await verify()).expect(200);
      latestCredential = fresh.body.credential.id;
      latestSigned = fresh.body.signedCredential;
      signatures.push(latestSigned);
      const current = (await database.db.query<{ verification_id: string }>("SELECT verification_id FROM public.credentials WHERE id = $1", [latestCredential])).rows[0]!.verification_id;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      signHook = async (key, bytes, signal) => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return key.sign(bytes, signal); };
      const pending = issue(current).then((r) => r);
      await started;
      await revoke(latestCredential).expect(200);
      release();
      assert.equal((await pending).status, 409);
      signHook = undefined;
      assert.equal((await check(latestSigned).expect(200)).body.valid, false);
    });

    await t.test("credential expiry is enforced at the exact signed expiration and cannot be extended by reissuance", async () => {
      const id = await verify();
      const fresh = await issue(id).expect(200);
      signatures.push(fresh.body.signedCredential);
      now = new Date(new Date(fresh.body.credential.expiresAt).getTime() - 1);
      assert.equal((await check(fresh.body.signedCredential).expect(200)).body.valid, true);
      now = new Date(fresh.body.credential.expiresAt);
      assert.equal((await status(fresh.body.credential.id).expect(200)).body.credential.status, "expired");
      assert.equal((await check(fresh.body.signedCredential).expect(200)).body.valid, false);
      await issue(id).expect(409);
    });

    await t.test("logs and persisted records contain neither credential contents nor identity data or access tokens", async () => {
      const storage = JSON.stringify({ credentials: (await database.db.query("SELECT * FROM public.credentials")).rows,
        audit: (await database.db.query("SELECT * FROM public.credential_audit_events")).rows,
        keys: (await database.db.query("SELECT * FROM public.credential_signing_keys")).rows });
      for (const value of [...signatures, tokenA, tokenB, "63184876213", "Bunch", "Dillon", "PRIVATE KEY"]) {
        assert.equal(logs.join("").includes(value), false);
        assert.equal(storage.includes(value), false);
      }
      assert(logs.some((line) => line.includes('"route":"credential_issue"')));
    });
  } finally { await app.close(); await database.close(); }
});
