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
import { APP_CONFIG, readConfig } from "../src/config/runtime-config";
import type { RuntimeConfig } from "../src/config/runtime-config";
import { DatabaseService } from "../src/database/database.service";
import { configureHttp } from "../src/http/configure-http";
import { RequestContext } from "../src/logging/request-context";
import { StructuredLogger } from "../src/logging/structured-logger";
import { createVerificationProvider } from "../src/verification/create-verification-provider";
import { MonnifyProvider } from "../src/verification/monnify-provider";
import { QoreidProvider } from "../src/verification/qoreid-provider";
import { VERIFICATION_PROVIDER } from "../src/verification/verification.provider";
import type { VerificationProvider } from "../src/verification/verification.provider";
import { cryptoFixture, EmbeddedDatabase } from "./auth-support";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://local:test@localhost/trueid" };

test("provider selection preserves QoreID and keeps Monnify unavailable without fallback", async () => {
  const existing = readConfig(base);
  assert.equal(existing.verificationProvider, "qoreid");
  assert(createVerificationProvider(existing) instanceof QoreidProvider);
  const config = readConfig({ ...base, TRUEID_VERIFICATION_PROVIDER: "monnify", TRUEID_MONNIFY_MODE: "disabled" });
  const provider = createVerificationProvider(config);
  assert(provider instanceof MonnifyProvider);
  assert.equal(provider.available, false);
  assert.deepEqual(await provider.verify({ nin: "63184876213", firstname: "Bunch", lastname: "Dillon" }, new AbortController().signal),
    { outcome: "provider_unavailable", reason: "provider_unavailable" });
  assert.throws(() => createVerificationProvider({ ...config, verificationProvider: "unknown" } as unknown as RuntimeConfig));
});

test("Monnify Live, Sandbox, credentials and arbitrary hosts cannot activate the runtime and config errors are redacted", () => {
  const marker = randomUUID();
  for (const env of [
    { TRUEID_VERIFICATION_PROVIDER: marker }, { TRUEID_VERIFICATION_PROVIDER: "monnify", NODE_ENV: "production" },
    ...["live", "production", "sandbox", "contract-test", marker].map((mode) => ({ TRUEID_MONNIFY_MODE: mode })),
    { TRUEID_MONNIFY_LIVE_API_KEY: marker }, { TRUEID_MONNIFY_PRODUCTION_SECRET_KEY: marker },
    { TRUEID_MONNIFY_TEST_API_KEY: marker }, { TRUEID_MONNIFY_TEST_SECRET_KEY: marker },
    { TRUEID_MONNIFY_API_KEY: marker }, { TRUEID_MONNIFY_SECRET_KEY: marker },
    { TRUEID_MONNIFY_BASE_URL: `https://${marker}.example/` }, { TRUEID_MONNIFY_ENABLED: "true" },
  ]) assert.throws(() => readConfig({ ...base, TRUEID_VERIFICATION_PROVIDER: "monnify", ...env }), (error: unknown) => {
    assert(error instanceof Error); assert.equal(error.message.includes(marker), false); return true;
  });
});

test("the actual Nest Monnify selection makes zero outgoing calls and creates no verification, credential or audit record", { timeout: 60000 }, async () => {
  const fixture = await cryptoFixture();
  const database = new EmbeddedDatabase();
  await database.initialize();
  const privateMarker = randomUUID();
  const config: RuntimeConfig = { ...fixture.config, verificationProvider: "monnify", qoreid: { mode: "sandbox", route: "nin", testClientId: randomUUID(), testClientSecret: privateMarker } };
  const logs: string[] = [];
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error(privateMarker); };
  let app: NestExpressApplication | undefined;
  try {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(config)
      .overrideProvider(DatabaseService).useValue(database)
      .overrideProvider(ACCESS_TOKEN_VERIFIER).useValue(new Auth0TokenVerifier(config.auth0, fixture.key))
      .overrideProvider(StructuredLogger).useFactory({ inject: [RequestContext], factory: (context: RequestContext) => new StructuredLogger("debug", context, (line) => logs.push(line)) })
      .compile();
    const provider = module.get<VerificationProvider>(VERIFICATION_PROVIDER);
    assert(provider instanceof MonnifyProvider);
    assert.equal(provider.available, false);
    app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    configureHttp(app, config);
    await app.init();
    const request = supertest(app.getHttpServer());
    const token = await fixture.token(randomUUID());
    await request.post("/api/v1/users/me").set("Authorization", `Bearer ${token}`).send({}).expect(200);
    const input = { nin: "63184876213", firstname: "Bunch", lastname: "Dillon" }; // QoreID-published Test data only; never sent.
    await request.post("/api/v1/verifications").set("Idempotency-Key", randomUUID()).send(input).expect(401);
    const key = randomUUID();
    for (const body of [input, { ...input, firstname: privateMarker }, input]) {
      const response = await request.post("/api/v1/verifications").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(body).expect(503);
      assert.equal(response.body.error.code, "verification_unavailable");
      assert.equal(response.text.includes(privateMarker), false);
      assert.equal(response.body.verification, undefined);
    }
    await request.post("/api/v1/verifications").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", randomUUID())
      .send({ ...input, provider: "qoreid" }).expect(400);
    await request.post("/api/v1/verifications/bvn").set("Authorization", `Bearer ${token}`).send({}).expect(404);
    await request.get(`/api/v1/verifications/${randomUUID()}`).set("Authorization", `Bearer ${token}`).expect(404);
    assert.equal(calls, 0);
    for (const table of ["verification_attempts", "audit_events", "credentials", "credential_audit_events"]) {
      assert.equal((await database.db.query(`SELECT id FROM public.${table}`)).rows.length, 0);
    }
    for (const value of [...Object.values(input), privateMarker, token]) assert.equal(logs.join("").includes(value), false);
  } finally { globalThis.fetch = previousFetch; await app?.close(); await database.close(); }
});
