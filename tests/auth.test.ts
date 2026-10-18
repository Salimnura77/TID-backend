import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { SignJWT, generateKeyPair } from "jose";
import { Auth0TokenVerifier } from "../src/auth/auth0-token-verifier";
import { ApiError } from "../src/http/api-error";
import { readConfig } from "../src/config/runtime-config";
import { cryptoFixture } from "./auth-support";

test("Auth0 verifier accepts only signed, scoped, native-client RFC 9068 access tokens", async (t) => {
  const fixture = await cryptoFixture();
  const verifier = new Auth0TokenVerifier(fixture.config.auth0, fixture.key);
  const subject = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await t.test("valid tokens expose only the immutable authentication binding", async () => {
    const sentinel = randomUUID();
    const identity = await verifier.verify(await fixture.token(subject, { arbitrary_private_claim: sentinel }));
    assert.deepEqual(identity, { issuer: fixture.config.auth0!.issuer, subject });
    assert.equal(Object.isFrozen(identity), true);
  });

  await t.test("wrong issuer/audience/client, expiry, future times, missing claims and machine tokens fail", async () => {
    const cases = [
      { iss: `https://${randomUUID()}.auth0.com/` }, { aud: randomUUID() },
      { client_id: randomUUID() }, { exp: now }, { nbf: now + 300 }, { iat: now + 300 },
      { exp: undefined }, { iat: undefined }, { jti: undefined }, { sub: "" },
      { sub: `${randomUUID()}@clients` }, { gty: "client-credentials" },
      { sub_profile: "ai_agent" }, { act: { sub: randomUUID() } },
      { exp: now + 0.5 }, { iat: now - 0.5 }, { sub: "x".repeat(256) },
    ];
    for (const claims of cases) {
      await assert.rejects(verifier.verify(await fixture.token(subject, claims)), (error: unknown) =>
        error instanceof ApiError && error.getStatus() === 401 && error.code === "unauthenticated");
    }
  });

  await t.test("ID tokens, untrusted signing keys, algorithm confusion and malformed input fail", async () => {
    await assert.rejects(verifier.verify(await fixture.token(subject, {}, { typ: "JWT" })), ApiError);
    await assert.rejects(verifier.verify(await fixture.token(subject, {}, { kid: randomUUID() })), ApiError);
    const otherKey = await generateKeyPair("RS256");
    const valid = await fixture.token(subject);
    const payload = JSON.parse(Buffer.from(valid.split(".")[1]!, "base64url").toString());
    const wrongSignature = await new SignJWT(payload).setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: JSON.parse(Buffer.from(valid.split(".")[0]!, "base64url").toString()).kid }).sign(otherKey.privateKey);
    await assert.rejects(verifier.verify(wrongSignature), ApiError);
    const symmetric = await new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).sign(randomBytes(32));
    await assert.rejects(verifier.verify(symmetric), ApiError);
    await assert.rejects(verifier.verify(`${valid.split(".").slice(0, 2).join(".")}.`), ApiError);
    await assert.rejects(verifier.verify("not-a-token"), ApiError);
  });

  await t.test("missing scope is forbidden, and an unconfigured provider has no bypass", async () => {
    await assert.rejects(verifier.verify(await fixture.token(subject, { scope: "openid" })), (error: unknown) => error instanceof ApiError && error.getStatus() === 403);
    await assert.rejects(new Auth0TokenVerifier(undefined).verify(await fixture.token(subject)), (error: unknown) => error instanceof ApiError && error.getStatus() === 503);
    const unavailable = new Auth0TokenVerifier(fixture.config.auth0, async () => { throw new TypeError("Sensitive provider connection details"); });
    await assert.rejects(unavailable.verify(await fixture.token(subject)), (error: unknown) => error instanceof ApiError && error.code === "authentication_unavailable" && !error.message.includes("Sensitive"));
  });
});

test("Auth0 configuration is all-or-none, sandbox-only, HTTPS and never includes a client secret", () => {
  const base = { NODE_ENV: "test", DATABASE_URL: `postgresql://${randomUUID()}:${randomUUID()}@localhost/trueid` };
  const auth = { TRUEID_AUTH0_TENANT_MODE: "sandbox", TRUEID_AUTH0_ISSUER: "https://configured.auth0.com/", TRUEID_AUTH0_AUDIENCE: "urn:trueid:test", TRUEID_AUTH0_MOBILE_CLIENT_ID: randomUUID() };
  assert.equal(readConfig(base).auth0, undefined);
  assert.equal(readConfig({ ...base, ...auth }).auth0!.issuer, auth.TRUEID_AUTH0_ISSUER);
  for (const invalid of [
    { TRUEID_AUTH0_ISSUER: auth.TRUEID_AUTH0_ISSUER }, { ...auth, TRUEID_AUTH0_TENANT_MODE: "production" },
    { ...auth, TRUEID_AUTH0_ISSUER: "http://configured.auth0.com/" },
    { ...auth, TRUEID_AUTH0_ISSUER: "https://configured.auth0.com/path" },
    { ...auth, TRUEID_AUTH0_ISSUER: "https://secret@configured.auth0.com/" },
    { ...auth, TRUEID_AUTH0_ISSUER: "https://configured.auth0.com/?token=secret" },
    { ...auth, TRUEID_AUTH0_ISSUER: "https://127.0.0.1/" },
    { ...auth, TRUEID_AUTH0_AUDIENCE: auth.TRUEID_AUTH0_MOBILE_CLIENT_ID },
    { ...auth, TRUEID_AUTH0_MOBILE_CLIENT_ID: "client secret" },
  ]) assert.throws(() => readConfig({ ...base, ...invalid }));
});
