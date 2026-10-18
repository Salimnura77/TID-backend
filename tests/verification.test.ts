import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
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
import { VERIFICATION_PROVIDER } from "../src/verification/verification.provider";
import type { VerificationProvider, VerificationResult } from "../src/verification/verification.provider";
import { cryptoFixture, EmbeddedDatabase } from "./auth-support";

const input = { nin: "63184876213", firstname: "Bunch", lastname: "Dillon" }; // Official QoreID Test input.
const verified: VerificationResult = { outcome: "verified", reason: "exact_match" };

test("verification state, authorization, duplicates and privacy remain enforced on the server", async (t) => {
  const fixture = await cryptoFixture();
  const database = new EmbeddedDatabase();
  await database.initialize();
  const logs: string[] = [];
  const privateMarker = randomUUID();
  let calls = 0;
  let configured = true;
  let handler: (signal: AbortSignal) => Promise<VerificationResult> = async () => verified;
  const provider: VerificationProvider = { get available() { return configured; }, async verify(_input, signal) { calls++; return handler(signal); } };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(fixture.config)
    .overrideProvider(DatabaseService).useValue(database)
    .overrideProvider(ACCESS_TOKEN_VERIFIER).useValue(new Auth0TokenVerifier(fixture.config.auth0, fixture.key))
    .overrideProvider(VERIFICATION_PROVIDER).useValue(provider)
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
  const submit = (token: string = tokenA, key: string = randomUUID(), body: unknown = input) => request.post("/api/v1/verifications")
    .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(body as object);
  const count = async () => (await database.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.verification_attempts")).rows[0]!.count;
  let ownId = "";
  let ownKey = "";
  try {
    await t.test("anonymous, malformed, caller-selected ownership and non-Test inputs are denied before provider calls", async () => {
      await request.post("/api/v1/verifications").set("Idempotency-Key", randomUUID()).send(input).expect(401);
      await request.get(`/api/v1/verifications/${randomUUID()}`).expect(401);
      for (const body of [{ ...input, accountId: accountA }, { ...input, document: privateMarker }, { ...input, phone: privateMarker },
        { ...input, nin: "0".repeat(11) }, { ...input, firstname: privateMarker }, { ...input, nin: 63184876213 }, {},
      ]) { const denied = await submit(tokenA, randomUUID(), body).expect(400); assert.equal(denied.text.includes(privateMarker), false); }
      await request.post("/api/v1/verifications").set("Authorization", `Bearer ${tokenA}`).send(input).expect(400);
      await submit(tokenA, privateMarker + "," + privateMarker).expect(400);
      await submit(tokenA).query({ accountId: accountA }).expect(400);
      assert.equal(calls, 0);
      assert.equal(await count(), 0);
    });

    await t.test("missing provider configuration fails closed without an attempt", async () => {
      configured = false;
      const denied = await submit().expect(503);
      assert.equal(denied.body.error.code, "verification_unavailable");
      assert.equal(await count(), 0);
      assert.equal(calls, 0);
      configured = true;
    });

    await t.test("successful verification stores only minimal metadata and returns no identity data", async () => {
      ownKey = randomUUID();
      const response = await submit(tokenA, ownKey).expect(200);
      ownId = response.body.verification.id;
      assert.equal(response.body.created, true);
      assert.equal(response.body.verification.outcome, "verified");
      assert.equal(response.body.verification.environment, "sandbox");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.match(ownId, /^[a-f0-9-]{14}4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.deepEqual(Object.keys(response.body.verification).sort(), ["completedAt", "environment", "id", "outcome", "provider", "reason", "route", "startedAt"]);
      const rows = (await database.db.query("SELECT * FROM public.verification_attempts")).rows;
      const events = (await database.db.query("SELECT * FROM public.audit_events")).rows;
      assert.equal(events.length, 2);
      for (const data of [response.body, rows, events]) for (const value of Object.values(input)) assert.equal(JSON.stringify(data).includes(value), false);
      assert.equal(response.text.includes(accountA), false);
    });

    await t.test("another user cannot read or select the owner's attempt; the same key is scoped per account", async () => {
      const denied = await request.get(`/api/v1/verifications/${ownId}`).set("Authorization", `Bearer ${tokenB}`).expect(404);
      assert.equal(denied.text.includes(ownId), false);
      await request.get(`/api/v1/verifications/${ownId}?accountId=${accountA}`).set("Authorization", `Bearer ${tokenB}`).expect(400);
      const owned = await request.get(`/api/v1/verifications/${ownId}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.equal(owned.body.verification.id, ownId);
      const other = await submit(tokenB, ownKey).set("X-Account-Id", accountA).expect(200);
      assert.notEqual(other.body.verification.id, ownId);
    });

    await t.test("replays return the original result without resubmission or altered inputs", async () => {
      const before = calls;
      const replay = await submit(tokenA, ownKey, { ...input, lastname: "Audi" }).expect(200);
      assert.equal(replay.body.created, false);
      assert.equal(replay.body.verification.id, ownId);
      assert.equal(replay.body.verification.outcome, "verified");
      assert.equal(calls, before);
      assert.equal(await count(), 2);
    });

    await t.test("concurrent duplicate requests make one provider call; different active submissions conflict", async () => {
      let release!: (value: VerificationResult) => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => { started = resolve; });
      handler = async () => { started(); return new Promise<VerificationResult>((resolve) => { release = resolve; }); };
      const key = randomUUID();
      const before = calls;
      const first = submit(tokenA, key).then((response) => response);
      await waiting;
      const repeated = await submit(tokenA, key).expect(200);
      assert.equal(repeated.body.verification.outcome, "in_progress");
      assert.equal(repeated.body.created, false);
      const conflict = await submit().expect(409);
      assert.equal(conflict.body.error.code, "verification_in_progress");
      release(verified);
      const completed = await first;
      assert.equal(completed.status, 200);
      assert.equal(completed.body.verification.id, repeated.body.verification.id);
      assert.equal(calls, before + 1);
      handler = async () => verified;
    });

    await t.test("all requested outcomes and provider exceptions persist only fixed safe codes", async () => {
      for (const result of [
        { outcome: "needs_review", reason: "partial_match" }, { outcome: "unable_to_verify", reason: "no_match" },
        { outcome: "timeout", reason: "provider_timeout" }, { outcome: "provider_unavailable", reason: "provider_unavailable" },
      ] as const) {
        handler = async () => ({ ...result, rawResponse: privateMarker } as unknown as VerificationResult);
        const response = await submit().expect(200);
        assert.equal(response.body.verification.outcome, result.outcome);
        assert.equal(response.text.includes(privateMarker), false);
      }
      handler = async () => { throw new Error(privateMarker + input.nin); };
      const failed = await submit().expect(200);
      assert.equal(failed.body.verification.outcome, "provider_unavailable");
      assert.equal(failed.text.includes(privateMarker), false);
      handler = async () => ({ outcome: "verified", reason: privateMarker } as unknown as VerificationResult);
      assert.equal((await submit().expect(200)).body.verification.outcome, "provider_unavailable");
      handler = async () => verified;
    });

    await t.test("an adapter that never settles is bounded and its request signal is aborted", async () => {
      let aborted = false;
      handler = async (signal) => { signal.addEventListener("abort", () => { aborted = true; }, { once: true }); return new Promise(() => undefined); };
      const response = await submit().expect(200);
      assert.equal(response.body.verification.outcome, "timeout");
      assert.equal(aborted, true);
      handler = async () => verified;
    });

    await t.test("stale crash reservations become terminal timeouts with coded audit metadata and never resubmit", async () => {
      const stale = await database.db.query<{ id: string }>(`INSERT INTO public.verification_attempts
        (account_id, submission_key, started_at, deadline_at) VALUES ($1, $2, clock_timestamp() - INTERVAL '40 seconds', clock_timestamp() - INTERVAL '1 second') RETURNING id`, [accountA, randomUUID()]);
      const before = calls;
      const result = await request.get(`/api/v1/verifications/${stale.rows[0]!.id}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.equal(result.body.verification.outcome, "timeout");
      assert.equal(result.body.verification.reason, "submission_timeout");
      assert.equal(calls, before);
      assert.equal((await database.db.query("SELECT id FROM public.audit_events WHERE verification_id = $1 AND event = 'verification_completed'", [stale.rows[0]!.id])).rows.length, 1);
      await submit().expect(200);
    });

    await t.test("database invariants reject terminal rewrites, invalid reason pairs, ownership changes and bad initial states", async () => {
      await assert.rejects(database.db.query("UPDATE public.verification_attempts SET outcome = 'needs_review', reason = 'partial_match' WHERE id = $1", [ownId]));
      await assert.rejects(database.db.query("UPDATE public.verification_attempts SET account_id = $2 WHERE id = $1", [ownId, randomUUID()]));
      await assert.rejects(database.db.query("INSERT INTO public.verification_attempts (account_id, submission_key, outcome, reason, completed_at) VALUES ($1, $2, 'verified', 'exact_match', clock_timestamp())", [accountA, randomUUID()]));
      const pending = (await database.db.query<{ id: string }>("INSERT INTO public.verification_attempts (account_id, submission_key) VALUES ($1, $2) RETURNING id", [accountA, randomUUID()])).rows[0]!.id;
      await assert.rejects(database.db.query("UPDATE public.verification_attempts SET outcome = 'verified', reason = NULL, completed_at = clock_timestamp() WHERE id = $1", [pending]));
      await assert.rejects(database.db.query("UPDATE public.verification_attempts SET outcome = 'verified', reason = 'no_match', completed_at = clock_timestamp() WHERE id = $1", [pending]));
      await assert.rejects(database.db.query("INSERT INTO public.verification_attempts (account_id, submission_key) VALUES ($1, $2)", [accountA, randomUUID()]));
      await database.db.query("UPDATE public.verification_attempts SET outcome = 'provider_unavailable', reason = 'provider_unavailable', completed_at = clock_timestamp() WHERE id = $1", [pending]);
    });

    await t.test("audit failures roll back state and a disabled account cannot finalize or disclose results", async () => {
      const audit = module.get(AuditService);
      const append = audit.verificationState.bind(audit);
      const before = await count();
      const beforeCalls = calls;
      audit.verificationState = async () => { throw new Error(privateMarker); };
      try { await submit().expect(500); } finally { audit.verificationState = append; }
      assert.equal(await count(), before);
      assert.equal(calls, beforeCalls);
      handler = async () => {
        await database.db.query("UPDATE public.accounts SET status = 'disabled', disabled_at = clock_timestamp() WHERE id = $1", [accountA]);
        return verified;
      };
      await submit().expect(403);
      await request.get(`/api/v1/verifications/${ownId}`).set("Authorization", `Bearer ${tokenA}`).expect(403);
      await submit().expect(403);
      const unfinished = await database.db.query("SELECT id FROM public.verification_attempts WHERE account_id = $1 AND outcome = 'in_progress'", [accountA]);
      assert.equal(unfinished.rows.length, 1);
      handler = async () => verified;
      await submit(tokenB).expect(200);
    });

    await t.test("logs, public errors and audit rows contain no identity inputs, tokens or provider data", async () => {
      const events = JSON.stringify((await database.db.query("SELECT * FROM public.audit_events")).rows);
      const persisted = JSON.stringify((await database.db.query("SELECT * FROM public.verification_attempts")).rows);
      for (const data of [logs.join(""), events, persisted]) for (const value of [...Object.values(input), tokenA, tokenB, privateMarker]) assert.equal(data.includes(value), false);
      assert(logs.some((line) => line.includes('"route":"verification_submit"')));
      assert.equal(logs.join("").includes(ownId), false);
    });
  } finally { await app.close(); await database.close(); }
});
