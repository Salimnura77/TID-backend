import "reflect-metadata";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { Controller, Get } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import supertest from "supertest";
import { AppModule } from "../src/app.module";
import { AuditService } from "../src/audit/audit.service";
import { ACCESS_TOKEN_VERIFIER } from "../src/auth/identity";
import { Auth0TokenVerifier } from "../src/auth/auth0-token-verifier";
import { APP_CONFIG } from "../src/config/runtime-config";
import { CONSENT_CLOCK, SHAREABLE_ATTRIBUTES } from "../src/consent/consent";
import type { ShareableAttribute } from "../src/consent/consent";
import { CREDENTIAL_CLOCK } from "../src/credentials/credential";
import { SIGNING_KEYS } from "../src/credentials/signing-key";
import { TestSigningKey } from "../src/credentials/test-signing-keys";
import { DatabaseService } from "../src/database/database.service";
import type { SqlExecutor, SqlRow } from "../src/database/sql-executor";
import { configureHttp } from "../src/http/configure-http";
import { RequestContext } from "../src/logging/request-context";
import { StructuredLogger } from "../src/logging/structured-logger";
import { matchingDigest, newPartnerKey, parsePartnerKey, secretDigest } from "../src/partners/partner-key";
import { PartnersService } from "../src/partners/partners.service";
import { disablePartner, listPartnerCredentials, provisionPartner, revokePartnerCredential, rotatePartnerCredential } from "../src/partners/provision-partner";
import { PartnerRoute } from "../src/partners/partner-route.decorator";
import { VERIFICATION_PROVIDER } from "../src/verification/verification.provider";
import { cryptoFixture, EmbeddedDatabase } from "./auth-support";

@PartnerRoute()
@Controller({ path: "partner/test-missing-permission", version: "1" })
class MissingPartnerPermissionController {
  @Get() read() { return { unexpected: true }; }
}

test("partner keys have separate random secrets, strict parsing and one-way constant-time comparisons", () => {
  const first = newPartnerKey();
  const second = newPartnerKey();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.key, second.key);
  assert.equal(Buffer.from(first.key.split(".")[1]!, "base64url").length, 32);
  assert.deepEqual(parsePartnerKey(first.key), { id: first.id, keyDigest: first.keyDigest });
  assert.equal(matchingDigest(first.keyDigest, secretDigest(first.key)), true);
  assert.equal(matchingDigest(first.keyDigest, second.keyDigest), false);
  for (const value of ["", first.key + ".extra", first.key + "\n", first.id, "Bearer " + first.key]) assert.equal(parsePartnerKey(value), undefined);
  assert.equal(matchingDigest("invalid", first.keyDigest), false);
});

test("partner requests and explicit consent gate every minimized disclosure", { timeout: 120000 }, async (t) => {
  const fixture = await cryptoFixture();
  const database = new EmbeddedDatabase();
  await database.initialize();
  const logs: string[] = [];
  const providerSecretMarker = randomUUID();
  let fixedNow: Date | undefined;
  const clock = { now: () => fixedNow ? new Date(fixedNow) : new Date() };
  const key = new TestSigningKey(`test-${randomUUID()}`, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [MissingPartnerPermissionController] })
    .overrideProvider(APP_CONFIG).useValue(fixture.config)
    .overrideProvider(DatabaseService).useValue(database)
    .overrideProvider(ACCESS_TOKEN_VERIFIER).useValue(new Auth0TokenVerifier(fixture.config.auth0, fixture.key))
    .overrideProvider(VERIFICATION_PROVIDER).useValue({ available: true, verify: async () => ({ outcome: "verified", reason: "exact_match", providerSecret: providerSecretMarker }) })
    .overrideProvider(SIGNING_KEYS).useValue({ mode: "test", active: async () => key, version: async () => key })
    .overrideProvider(CREDENTIAL_CLOCK).useValue(clock)
    .overrideProvider(CONSENT_CLOCK).useValue(clock)
    .overrideProvider(StructuredLogger).useFactory({ inject: [RequestContext], factory: (context: RequestContext) => new StructuredLogger("debug", context, (line) => logs.push(line)) })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureHttp(app, fixture.config);
  await app.init();
  const request = supertest(app.getHttpServer());
  const tokenA = await fixture.token(randomUUID());
  const tokenB = await fixture.token(randomUUID());
  const accountA = (await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({}).expect(200)).body.account.id as string;
  const accountB = (await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).send({}).expect(200)).body.account.id as string;
  const partnerA = await database.transaction((client) => provisionPartner(client, `Integration ${randomUUID()}`));
  const partnerB = await database.transaction((client) => provisionPartner(client, `Integration ${randomUUID()}`));
  const partnerDisabled = await database.transaction((client) => provisionPartner(client, `Integration ${randomUUID()}`));
  const partnerSecrets = [partnerA.apiKey, partnerB.apiKey, partnerDisabled.apiKey];
  const purpose = `Technical consent test ${randomUUID()}`;
  const invitations: string[] = [];
  const signedCredentials: string[] = [];
  let credentialId = "";
  const freshCredential = async () => {
    const verification = await request.post("/api/v1/verifications").set("Authorization", `Bearer ${tokenA}`).set("Idempotency-Key", randomUUID())
      .send({ nin: "63184876213", firstname: "Bunch", lastname: "Dillon" }).expect(200);
    const issued = await request.post("/api/v1/credentials").set("Authorization", `Bearer ${tokenA}`).send({ verificationId: verification.body.verification.id }).expect(200);
    signedCredentials.push(issued.body.signedCredential);
    credentialId = issued.body.credential.id;
    return credentialId;
  };
  const invite = async (partner = partnerA, token = tokenA, credential = credentialId) => {
    const result = await request.post("/api/v1/consent/invitations").set("Authorization", `Bearer ${token}`)
      .send({ partnerId: partner.id, credentialId: credential }).expect(200);
    invitations.push(result.body.invitation);
    return result.body as { invitation: string; expiresAt: string };
  };
  interface RequestView { id: string; purpose: string; expiresAt: string; requestedAttributes: ShareableAttribute[]; approvedAttributes: ShareableAttribute[]; approvedExpiresAt: string; revision: number; status: string }
  const create = async (partner = partnerA, attributes: readonly ShareableAttribute[] = SHAREABLE_ATTRIBUTES): Promise<RequestView> => {
    const invitation = await invite(partner);
    const result = await request.post("/api/v1/partner/requests").set("Authorization", `Bearer ${partner.apiKey}`)
      .send({ invitation: invitation.invitation, purpose, attributes, expiresAt: new Date(Date.parse(invitation.expiresAt) - 1000).toISOString() }).expect(200);
    return result.body.request;
  };
  const decide = (record: RequestView, body: object, token = tokenA) => request.post(`/api/v1/consent/requests/${record.id}/decision`)
    .set("Authorization", `Bearer ${token}`).send({ revision: record.revision, ...body });
  const approve = async (record: RequestView, attributes: readonly ShareableAttribute[] = record.requestedAttributes): Promise<RequestView> =>
    (await decide(record, { decision: "approve", attributes, expiresAt: record.expiresAt }).expect(200)).body.request;
  const context = (record: RequestView) => ({ purpose: record.purpose, attributes: record.approvedAttributes ?? record.requestedAttributes,
    expiresAt: record.approvedExpiresAt ?? record.expiresAt, revision: record.revision || 1 });
  const disclose = (record: RequestView, partner = partnerA, overrides: object = {}) => request.post(`/api/v1/partner/requests/${record.id}/disclosure`)
    .set("Authorization", `Bearer ${partner.apiKey}`).send({ ...context(record), ...overrides });
  const revoke = (record: RequestView, token = tokenA) => request.post(`/api/v1/consent/requests/${record.id}/revoke`).set("Authorization", `Bearer ${token}`).send({});
  const history = (record: RequestView, token = tokenA) => request.get(`/api/v1/consent/requests/${record.id}/history`).set("Authorization", `Bearer ${token}`);
  const denied = async (result: PromiseLike<supertest.Response>) => {
    const response = await result;
    assert(response.status >= 400);
    assert.equal(response.body.disclosure, undefined);
    assert.equal(response.body.attributes, undefined);
    assert.equal(response.body.pairwiseId, undefined);
    return response;
  };
  let approved: RequestView;
  let firstPairwise = "";
  try {
    await freshCredential();
    await t.test("only the correct principal type reaches either API; missing, unknown and altered keys disclose nothing", async () => {
      const wrongSecret = `${partnerA.apiKey.split(".")[0]}.${newPartnerKey().key.split(".")[1]}`;
      for (const value of [undefined, tokenA, newPartnerKey().key, wrongSecret, partnerA.apiKey.replace(/.$/, "!")]) {
        const call = request.post("/api/v1/partner/requests").send({});
        if (value) call.set("Authorization", `Bearer ${value}`);
        await denied(call.expect(401));
      }
      await request.get("/api/v1/users/me").set("Authorization", `Bearer ${partnerA.apiKey}`).expect(401);
      await request.get("/api/v1/consent/requests").expect(401);
      await request.get("/api/v1/consent/requests").set("Authorization", `Bearer ${partnerA.apiKey}`).expect(401);
      const partner = await request.get(`/api/v1/consent/partners/${partnerA.id}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.deepEqual(partner.body.partner, { id: partnerA.id, name: partnerA.name });
      assert.equal(partner.text.includes(partnerA.apiKey), false);
      const rows = (await database.db.query<{ key_digest: string }>("SELECT key_digest FROM public.partner_api_credentials")).rows;
      assert(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key_digest)));
    });
    await t.test("invitations bind an owned credential to one partner and are consumed exactly once", async () => {
      await request.post("/api/v1/consent/invitations").set("Authorization", `Bearer ${tokenB}`).send({ partnerId: partnerA.id, credentialId }).expect(404);
      const invitation = await invite();
      const body = { invitation: invitation.invitation, purpose, attributes: SHAREABLE_ATTRIBUTES, expiresAt: invitation.expiresAt };
      await denied(request.post("/api/v1/partner/requests").set("Authorization", `Bearer ${partnerB.apiKey}`).send(body).expect(404));
      for (const override of [{ partnerId: partnerB.id }, { accountId: accountB }, { purpose: " " }, { purpose: "\u0000value" },
        { attributes: ["nin"] }, { attributes: [] }, { attributes: ["verification_result", "verification_result"] },
        { expiresAt: new Date(Date.parse(invitation.expiresAt) + 1).toISOString() }, { expiresAt: new Date(0).toISOString() }]) {
        await denied(request.post("/api/v1/partner/requests").set("Authorization", `Bearer ${partnerA.apiKey}`).send({ ...body, ...override }).expect(400));
      }
      const responses = await Promise.all([1, 2].map(() => request.post("/api/v1/partner/requests").set("Authorization", `Bearer ${partnerA.apiKey}`).send(body)));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const response = responses.find((r) => r.status === 200)!;
      assert.equal(response.body.request.status, "pending");
      for (const privateValue of [accountA, credentialId, partnerA.apiKey, invitation.invitation]) assert.equal(response.text.includes(privateValue), false);
      const pending: RequestView = response.body.request;
      await denied(disclose(pending).expect(403));
      await request.get(`/api/v1/consent/requests/${pending.id}`).set("Authorization", `Bearer ${tokenB}`).expect(404);
      await decide(pending, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES, expiresAt: pending.expiresAt }, tokenB).expect(404);
      await revoke(pending, tokenB).expect(404);
      const listB = await request.get("/api/v1/consent/requests").set("Authorization", `Bearer ${tokenB}`).expect(200);
      assert.deepEqual(listB.body.requests, []);
    });
    await t.test("explicit approval can minimize the request and returns exactly those values with a stable pairwise ID", async () => {
      const pending = await create();
      const before = await request.get(`/api/v1/partner/requests/${pending.id}`).set("Authorization", `Bearer ${partnerA.apiKey}`).expect(200);
      assert.equal(before.body.disclosure, undefined);
      approved = await approve(pending, ["verification_result"]);
      const result = await disclose(approved).expect(200);
      assert.deepEqual(result.body.disclosure.attributes, { verification_result: "verified" });
      firstPairwise = result.body.disclosure.pairwiseId;
      assert.notEqual(firstPairwise, accountA);
      assert.equal(result.body.disclosure.test, true);
      assert.equal(result.headers["cache-control"], "no-store");
      for (const value of [accountA, accountB, credentialId, signedCredentials[0]!]) assert.equal(result.text.includes(value), false);
      assert.equal((await disclose(approved).expect(200)).body.disclosure.pairwiseId, firstPairwise);
      const own = await request.get(`/api/v1/consent/requests/${pending.id}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.equal(own.body.request.partner.name, partnerA.name);
      assert.equal(own.body.request.credentialId, credentialId);
    });
    await t.test("a different partner, purpose, field set, expiry, revision or extra query cannot reuse approval", async () => {
      await denied(disclose(approved, partnerB).expect(404));
      await request.get(`/api/v1/partner/requests/${approved.id}`).set("Authorization", `Bearer ${partnerB.apiKey}`).expect(404);
      for (const override of [{ purpose: purpose + " changed" }, { attributes: SHAREABLE_ATTRIBUTES },
        { attributes: ["verification_expires_at"] }, { expiresAt: new Date(Date.parse(approved.approvedExpiresAt) - 1).toISOString() }, { revision: approved.revision + 1 }]) {
        await denied(disclose(approved, partnerA, override).expect(403));
      }
      await denied(disclose(approved).query({ accountId: accountA }).expect(400));
    });
    await t.test("decline is explicit and terminal; neither a later approval nor reads create access", async () => {
      const pending = await create();
      await decide(pending, { decision: "decline", attributes: ["verification_result"] }).expect(400);
      const declined: RequestView = (await decide(pending, { decision: "decline" }).expect(200)).body.request;
      assert.equal(declined.status, "declined");
      await denied(disclose(declined).expect(403));
      await decide(declined, { decision: "approve", attributes: ["verification_result"], expiresAt: declined.expiresAt }).expect(409);
      await decide(pending, { decision: "approve", attributes: ["verification_result"], expiresAt: pending.expiresAt }).expect(409);
    });
    await t.test("approval amendments take effect immediately and invalidate the previous scope and revision", async () => {
      const broad = await approve(await create());
      assert.deepEqual(Object.keys((await disclose(broad).expect(200)).body.disclosure.attributes).sort(), [...SHAREABLE_ATTRIBUTES]);
      const narrow = (await decide(broad, { decision: "approve", attributes: ["verification_result"], expiresAt: new Date(Date.parse(broad.expiresAt) - 1000).toISOString() }).expect(200)).body.request as RequestView;
      await denied(disclose(broad).expect(403));
      assert.deepEqual((await disclose(narrow).expect(200)).body.disclosure.attributes, { verification_result: "verified" });
      await decide(broad, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES, expiresAt: broad.expiresAt }).expect(409);
      const onlyResult = await create(partnerA, ["verification_result"]);
      await decide(onlyResult, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES, expiresAt: onlyResult.expiresAt }).expect(400);
    });
    await t.test("revocation is idempotent, immediately blocks reads and defeats a stale approval", async () => {
      const grant = await approve(await create());
      await disclose(grant).expect(200);
      const revoked = await revoke(grant).expect(200);
      assert.equal(revoked.body.request.status, "revoked");
      await revoke(grant).expect(200);
      await denied(disclose(grant).expect(403));
      await decide(revoked.body.request, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES, expiresAt: grant.expiresAt }).expect(409);
      const events = await database.db.query("SELECT id FROM public.consent_audit_events WHERE request_id = $1 AND event = 'consent_revoked'", [grant.id]);
      assert.equal(events.rows.length, 1);
    });
    await t.test("competing decisions cannot both commit; revocation wins over a concurrent amendment", async () => {
      const pending = await create();
      const decisions = await Promise.all([
        decide(pending, { decision: "approve", attributes: ["verification_result"], expiresAt: pending.expiresAt }),
        decide(pending, { decision: "decline" }),
      ]);
      assert.deepEqual(decisions.map((result) => result.status).sort(), [200, 409]);
      const grant = await approve(await create());
      const results = await Promise.all([
        revoke(grant), decide(grant, { decision: "approve", attributes: ["verification_result"], expiresAt: grant.expiresAt }),
      ]);
      assert.equal(results[0]!.status, 200);
      assert([200, 409].includes(results[1]!.status));
      await denied(disclose(grant).expect(403));
      const current = await request.get(`/api/v1/consent/requests/${grant.id}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.equal(current.body.request.status, "revoked");
    });
    await t.test("pending requests, approvals and invitations expire at the exact UTC instant", async () => {
      const invitation = await invite();
      const pending = await create();
      const grant = await approve(await create());
      const shorter = (await decide(grant, { decision: "approve", attributes: ["verification_result"], expiresAt: new Date(Date.now() + 30000).toISOString() }).expect(200)).body.request as RequestView;
      try {
        fixedNow = new Date(shorter.approvedExpiresAt);
        await denied(disclose(shorter).expect(403));
        await decide(shorter, { decision: "approve", attributes: ["verification_result"], expiresAt: shorter.expiresAt }).expect(409);
        fixedNow = new Date(pending.expiresAt);
        await decide(pending, { decision: "approve", attributes: ["verification_result"], expiresAt: pending.expiresAt }).expect(409);
        await denied(disclose(pending).expect(403));
        fixedNow = new Date(invitation.expiresAt);
        await request.post("/api/v1/partner/requests").set("Authorization", `Bearer ${partnerA.apiKey}`)
          .send({ invitation: invitation.invitation, purpose, attributes: SHAREABLE_ATTRIBUTES, expiresAt: invitation.expiresAt }).expect(409);
      } finally { fixedNow = undefined; }
    });
    await t.test("the same user has a distinct identifier at each partner, stable across requests", async () => {
      const grant = await approve(await create(partnerB));
      const response = await disclose(grant, partnerB).expect(200);
      assert.notEqual(response.body.disclosure.pairwiseId, firstPairwise);
      assert.notEqual(response.body.disclosure.pairwiseId, accountA);
      const next = await approve(await create());
      assert.equal((await disclose(next).expect(200)).body.disclosure.pairwiseId, firstPairwise);
    });
    await t.test("rotation replaces the secret without changing partner, consent or pairwise identity", async () => {
      const grant = await approve(await create());
      const before = (await database.db.query("SELECT * FROM public.consent_requests WHERE id = $1", [grant.id])).rows;
      const previous = { ...partnerA };
      const next = await database.transaction((client) => rotatePartnerCredential(client, partnerA.id, partnerA.credentialId));
      partnerSecrets.push(next.apiKey);
      assert.equal(next.id, partnerA.id);
      assert.notEqual(next.credentialId, previous.credentialId);
      assert.notEqual(next.apiKey, previous.apiKey);
      await denied(disclose(grant, previous).expect(401));
      await request.get(`/api/v1/partner/requests/${grant.id}`).set("Authorization", `Bearer ${previous.apiKey}`).expect(401);
      Object.assign(partnerA, next);
      assert.equal((await disclose(grant).expect(200)).body.disclosure.pairwiseId, firstPairwise);
      assert.deepEqual((await database.db.query("SELECT * FROM public.consent_requests WHERE id = $1", [grant.id])).rows, before);
      await assert.rejects(database.transaction((client) => rotatePartnerCredential(client, partnerA.id, previous.credentialId)));
      await assert.rejects(database.transaction((client) => revokePartnerCredential(client, partnerB.id, partnerA.credentialId)));
      await assert.rejects(database.transaction((client) => rotatePartnerCredential(client, partnerB.id, partnerA.credentialId)));
      const events = (await database.db.query<{ event: string }>("SELECT event FROM public.partner_credential_audit_events WHERE credential_id = $1", [previous.credentialId])).rows;
      assert(events.some((event) => event.event === "credential_revoked"));
      const actor = (await database.db.query<{ partner_credential_id: string }>("SELECT partner_credential_id FROM public.consent_audit_events WHERE request_id = $1 AND event = 'attributes_disclosed'", [grant.id])).rows[0]!;
      assert.equal(actor.partner_credential_id, next.credentialId);
      const metadata = await database.transaction((client) => listPartnerCredentials(client, partnerA.id));
      assert.equal(metadata.filter((item) => item.revokedAt === null).length, 1);
      for (const value of [previous.apiKey, next.apiKey, secretDigest(next.apiKey)]) assert.equal(JSON.stringify(metadata).includes(value), false);
    });
    await t.test("credential permissions allow only named endpoints; unscoped partner routes remain closed", async () => {
      const client = await database.transaction((tx) => provisionPartner(tx, `Integration ${randomUUID()}`));
      partnerSecrets.push(client.apiKey);
      const grant = await approve(await create(client));
      const readOnly = await database.transaction((tx) => rotatePartnerCredential(tx, client.id, client.credentialId, ["requests:read"]));
      partnerSecrets.push(readOnly.apiKey);
      await request.get(`/api/v1/partner/requests/${grant.id}`).set("Authorization", `Bearer ${readOnly.apiKey}`).expect(200);
      await denied(disclose(grant, readOnly).expect(403));
      await request.post("/api/v1/partner/requests").set("Authorization", `Bearer ${readOnly.apiKey}`).send({}).expect(403);
      await request.get(`/api/v1/partner/requests/${approved.id}`).set("Authorization", `Bearer ${readOnly.apiKey}`).expect(404);
      await history(grant, readOnly.apiKey).expect(401);
      await request.get("/api/v1/partner/test-missing-permission").set("Authorization", `Bearer ${partnerA.apiKey}`).expect(403);
      await assert.rejects(database.transaction((tx) => rotatePartnerCredential(tx, client.id, readOnly.credentialId, ["requests:read", "disclosures:create"])));
      await database.transaction((tx) => revokePartnerCredential(tx, client.id, readOnly.credentialId));
      await database.transaction((tx) => revokePartnerCredential(tx, client.id, readOnly.credentialId));
      await request.get(`/api/v1/partner/requests/${grant.id}`).set("Authorization", `Bearer ${readOnly.apiKey}`).expect(401);
      for (const endpoint of ["/api/v1/partners/register", "/api/v1/partner/credentials/rotate", "/api/v1/partner/credentials/revoke"]) {
        await request.post(endpoint).set("Authorization", `Bearer ${partnerA.apiKey}`).send({}).expect(404);
      }
    });
    await t.test("key revocation after guard authentication prevents disclosure and a fresh replacement never restores the old key", async () => {
      const grant = await approve(await create());
      const previous = { ...partnerA };
      const partners = module.get(PartnersService);
      const original = partners.authenticate.bind(partners);
      partners.authenticate = async (...args) => {
        const identity = await original(...args);
        await database.transaction((tx) => revokePartnerCredential(tx, identity.id, identity.credentialId));
        return identity;
      };
      try { await denied(disclose(grant).expect(401)); } finally { partners.authenticate = original; }
      const none = await database.db.query("SELECT id FROM public.consent_audit_events WHERE request_id = $1 AND event = 'attributes_disclosed'", [grant.id]);
      assert.equal(none.rows.length, 0);
      await assert.rejects(database.db.query("UPDATE public.partner_api_credentials SET revoked_at = NULL WHERE id = $1", [previous.credentialId]));
      const next = await database.transaction((tx) => rotatePartnerCredential(tx, previous.id, previous.credentialId));
      partnerSecrets.push(next.apiKey);
      Object.assign(partnerA, next);
      await denied(disclose(grant, previous).expect(401));
      assert.equal((await disclose(grant).expect(200)).body.disclosure.pairwiseId, firstPairwise);
    });
    await t.test("a failed rotation audit rolls back both replacement and old-key revocation", async () => {
      const grant = await approve(await create());
      const previous = { ...partnerA };
      const marker = randomUUID();
      await assert.rejects(database.transaction((tx) => {
        const failing: SqlExecutor = { async query<Row extends SqlRow>(sql: string, values?: unknown[]) {
          if (sql.includes("INSERT INTO public.partner_credential_audit_events") && values?.[2] === "credential_rotated") throw new Error(marker);
          return tx.query<Row>(sql, values);
        } };
        return rotatePartnerCredential(failing, previous.id, previous.credentialId);
      }));
      await disclose(grant).expect(200);
      const active = (await database.db.query<{ id: string }>("SELECT id FROM public.partner_api_credentials WHERE partner_id = $1 AND revoked_at IS NULL", [partnerA.id])).rows;
      assert.deepEqual(active, [{ id: previous.credentialId }]);
      await assert.rejects(database.db.query("UPDATE public.partner_api_credentials SET permissions = ARRAY['requests:read'] WHERE id = $1", [previous.credentialId]));
      const duplicate = newPartnerKey(partnerA.id);
      await assert.rejects(database.db.query("INSERT INTO public.partner_api_credentials (partner_id, key_digest, permissions) VALUES ($1, $2, ARRAY['requests:read'])", [partnerA.id, duplicate.keyDigest]));
    });
    await t.test("the owner can review coded request, decision, disclosure and revocation history without exposing values", async () => {
      const grant = await approve(await create());
      await disclose(grant).expect(200);
      await revoke(grant).expect(200);
      const response = await history(grant).expect(200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.body.nextCursor, null);
      const events = response.body.events as { id: string; event: string; requestId: string; partnerId: string; occurredAt: string; actor: string }[];
      assert.deepEqual(events.map((event) => event.event), ["consent_revoked", "attributes_disclosed", "consent_approved", "request_created"]);
      assert.deepEqual(events.map((event) => event.actor), ["user", "partner", "user", "partner"]);
      for (const event of events) {
        assert.equal(event.requestId, grant.id);
        assert.equal(event.partnerId, partnerA.id);
        assert.equal(new Date(event.occurredAt).toISOString(), event.occurredAt);
        assert.deepEqual(Object.keys(event).sort(), ["actor", "event", "id", "occurredAt", "partnerId", "requestId", "revision"]);
      }
      for (const value of [accountA, credentialId, providerSecretMarker, tokenA, ...partnerSecrets, ...invitations, ...signedCredentials, purpose, "63184876213", "Bunch", "Dillon"]) assert.equal(response.text.includes(value), false);
      await history(grant, tokenB).expect(404);
      await history(grant, partnerA.apiKey).expect(401);
      await request.get(`/api/v1/consent/requests/${grant.id}/history`).expect(401);
      await history(grant).query({ accountId: accountB }).expect(400);
      await history(grant).query({ cursor: randomUUID() }).expect(400);
      await history(grant).query({ cursor: "not-an-event" }).expect(400);
      const pending = await create();
      const declined = (await decide(pending, { decision: "decline" }).expect(200)).body.request as RequestView;
      const declinedHistory = await history(declined).expect(200);
      assert.deepEqual(declinedHistory.body.events.map((event: { event: string }) => event.event), ["consent_declined", "request_created"]);
      await history(declined).query({ cursor: events[0]!.id }).expect(400);
    });
    await t.test("history pagination returns every event once and scopes its cursor to the owned request", async () => {
      const grant = await approve(await create());
      for (let i = 0; i < 50; i++) await disclose(grant).expect(200);
      const first = await history(grant).expect(200);
      assert.equal(first.body.events.length, 50);
      assert.equal(typeof first.body.nextCursor, "string");
      const second = await history(grant).query({ cursor: first.body.nextCursor }).expect(200);
      assert.equal(second.body.events.length, 2);
      assert.equal(second.body.nextCursor, null);
      const ids = [...first.body.events, ...second.body.events].map((event: { id: string }) => event.id);
      assert.equal(new Set(ids).size, 52);
      const rows = (await database.db.query<{ id: string }>("SELECT id FROM public.consent_audit_events WHERE request_id = $1", [grant.id])).rows;
      assert.deepEqual(new Set(ids), new Set(rows.map((row) => row.id)));
      await history(grant, tokenB).query({ cursor: first.body.nextCursor }).expect(404);
    });
    await t.test("an amendment cannot extend a grant that expires while waiting for a lifecycle lock", async () => {
      const pending = await create();
      const grant = (await decide(pending, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES,
        expiresAt: new Date(Date.now() + 30000).toISOString() }).expect(200)).body.request as RequestView;
      const partners = module.get(PartnersService);
      const original = partners.requireActive.bind(partners);
      partners.requireActive = async (...args) => {
        const result = await original(...args);
        fixedNow = new Date(grant.approvedExpiresAt);
        return result;
      };
      try {
        const result = await decide(grant, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES, expiresAt: grant.expiresAt }).expect(409);
        assert.equal(result.body.error.code, "consent_conflict");
      } finally { partners.requireActive = original; fixedNow = undefined; }
    });
    await t.test("expiry during disclosure processing withholds values and rolls back the disclosure audit", async () => {
      const grant = await approve(await create());
      const audit = module.get(AuditService);
      const original = audit.consentState.bind(audit);
      audit.consentState = async (...args) => {
        await original(...args);
        if (args[5] === "attributes_disclosed") fixedNow = new Date(grant.approvedExpiresAt);
      };
      try { await denied(disclose(grant).expect(403)); } finally { audit.consentState = original; fixedNow = undefined; }
      const events = await database.db.query("SELECT id FROM public.consent_audit_events WHERE request_id = $1 AND event = 'attributes_disclosed'", [grant.id]);
      assert.equal(events.rows.length, 0);
    });
    await t.test("audit failure rolls back consent changes and withholds disclosure", async () => {
      const pending = await create();
      const audit = module.get(AuditService);
      const original = audit.consentState.bind(audit);
      const marker = randomUUID();
      audit.consentState = async () => { throw new Error(marker); };
      try {
        const response = await decide(pending, { decision: "approve", attributes: SHAREABLE_ATTRIBUTES, expiresAt: pending.expiresAt }).expect(500);
        assert.equal(response.text.includes(marker), false);
        await denied(disclose(approved).expect(500));
      } finally { audit.consentState = original; }
      const record = await request.get(`/api/v1/consent/requests/${pending.id}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.equal(record.body.request.status, "pending");
      assert.equal(record.body.request.revision, 0);
    });
    await t.test("database invariants forbid scope mutation, forged approval metadata, cross-account bindings and terminal resurrection", async () => {
      const pending = await create();
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET purpose = 'changed' WHERE id = $1", [pending.id]));
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET partner_id = $2 WHERE id = $1", [pending.id, partnerB.id]));
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET account_id = $2 WHERE id = $1", [pending.id, accountB]));
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET state = 'approved', revision = 1 WHERE id = $1", [pending.id]));
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET state = 'approved', revision = 1, approved_attributes = ARRAY['nin'], approved_expires_at = expires_at, decided_at = clock_timestamp() WHERE id = $1", [pending.id]));
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET state = 'declined', revision = 1 WHERE id = $1", [pending.id]));
      const grant = await approve(pending);
      await revoke(grant).expect(200);
      await assert.rejects(database.db.query("UPDATE public.consent_requests SET state = 'approved', revoked_at = NULL, revision = revision + 1 WHERE id = $1", [pending.id]));
      await assert.rejects(database.db.query("UPDATE public.partner_pairwise_ids SET identifier = gen_random_uuid() WHERE account_id = $1", [accountA]));
      await assert.rejects(database.db.query("DELETE FROM public.consent_audit_events WHERE request_id = $1", [pending.id]));
      for (const credential of [null, partnerB.credentialId]) {
        await assert.rejects(database.db.query(`INSERT INTO public.consent_audit_events
          (account_id, partner_id, request_id, event, revision, partner_credential_id)
          VALUES ($1, $2, $3, 'attributes_disclosed', 1, $4)`, [accountA, partnerA.id, pending.id, credential]));
      }
    });
    await t.test("credential revocation and reverification never transfer existing grants to a fresh credential", async () => {
      const grant = await approve(await create());
      await request.post(`/api/v1/credentials/${credentialId}/revoke`).set("Authorization", `Bearer ${tokenA}`).send({}).expect(200);
      await denied(disclose(grant).expect(403));
      const oldCredential = credentialId;
      await freshCredential();
      assert.notEqual(credentialId, oldCredential);
      await denied(disclose(grant).expect(403));
      const freshGrant = await approve(await create());
      assert.equal((await disclose(freshGrant).expect(200)).body.disclosure.pairwiseId, firstPairwise);
      await freshCredential();
      await denied(disclose(freshGrant).expect(403));
    });
    await t.test("inactive partners and disabled accounts cannot disclose, including disabling after guard authentication", async () => {
      const grant = await approve(await create(partnerDisabled));
      const partners = module.get(PartnersService);
      const original = partners.authenticate.bind(partners);
      partners.authenticate = async (...args) => {
        const identity = await original(...args);
        await database.transaction((client) => disablePartner(client, identity.id));
        return identity;
      };
      try { await denied(disclose(grant, partnerDisabled).expect(401)); } finally { partners.authenticate = original; }
      await denied(disclose(grant, partnerDisabled).expect(401));
      await revoke(grant).expect(200); // Users can still withdraw from a disabled partner.
      const active = await approve(await create());
      await database.db.query("UPDATE public.accounts SET status = 'disabled', disabled_at = clock_timestamp() WHERE id = $1", [accountA]);
      await denied(disclose(active).expect(403));
      await request.get("/api/v1/consent/requests").set("Authorization", `Bearer ${tokenA}`).expect(403);
      await history(active).expect(403);
    });
    await t.test("logs, errors, audit and storage omit secrets, raw identity data and disclosed values", async () => {
      const logText = logs.join("");
      const auditText = JSON.stringify((await database.db.query("SELECT * FROM public.consent_audit_events")).rows) + JSON.stringify((await database.db.query("SELECT * FROM public.partner_credential_audit_events")).rows);
      const storage = JSON.stringify((await database.db.query("SELECT * FROM public.consent_requests")).rows) + JSON.stringify((await database.db.query("SELECT * FROM public.consent_invitations")).rows);
      for (const value of [tokenA, tokenB, ...partnerSecrets, providerSecretMarker, purpose, accountA, firstPairwise, ...invitations, ...signedCredentials, "63184876213", "Bunch", "Dillon"]) assert.equal(logText.includes(value), false);
      for (const value of [tokenA, tokenB, providerSecretMarker, purpose, ...invitations, ...signedCredentials, ...partnerSecrets, "63184876213", "Bunch", "Dillon"]) assert.equal(auditText.includes(value), false);
      for (const value of [...invitations, ...signedCredentials, ...partnerSecrets, providerSecretMarker, "63184876213", "Bunch", "Dillon"]) assert.equal(storage.includes(value), false);
      const hashes = (await database.db.query<{ key_digest: string }>("SELECT key_digest FROM public.partner_api_credentials")).rows;
      for (const row of hashes) { assert.equal(auditText.includes(row.key_digest), false); assert.equal(logText.includes(row.key_digest), false); }
      assert.equal(logText.includes('"verified"'), false);
      assert.equal(logText.includes('"route":"partner_disclosure"'), true);
      assert.equal(auditText.includes('"verification_result"'), false);
    });
  } finally { await app.close(); }
});
