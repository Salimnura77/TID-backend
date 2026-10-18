import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import { decodeJwt, importJWK, jwtVerify, SignJWT } from "jose";
import { readConfig } from "../src/config/runtime-config";
import { TestSigningKey, TestSigningKeys } from "../src/credentials/test-signing-keys";
import { ManagedSigningKey } from "../src/credentials/signing-key";
import { credentialStatus, credentialClaims, CREDENTIAL_AUDIENCE, CREDENTIAL_ISSUER, CREDENTIAL_TYPE } from "../src/credentials/credential";
import type { CredentialRecord } from "../src/credentials/credential";
import { credentialKeyId, publicVerificationKey, signCredential, verifyCredentialSignature } from "../src/credentials/credential-jws";

test("credential signing accepts only dedicated Test configuration and a Test key namespace", async () => {
  const base = { NODE_ENV: "test", DATABASE_URL: `postgresql://${randomUUID()}:${randomUUID()}@localhost/trueid` };
  const configured = { ...base, TRUEID_CREDENTIAL_SIGNING_MODE: "test", TRUEID_TEST_SIGNING_KEY_ID: `test-${randomUUID()}` };
  assert(readConfig(configured).testSigning);
  for (const invalid of [
    { ...configured, NODE_ENV: "development" }, { ...configured, NODE_ENV: "production" },
    { ...configured, TRUEID_CREDENTIAL_SIGNING_MODE: "production" }, { ...configured, TRUEID_CREDENTIAL_SIGNING_MODE: "" },
    { ...configured, TRUEID_TEST_SIGNING_KEY_ID: "../key" }, { ...configured, TRUEID_TEST_SIGNING_KEY_ID: "" },
  ]) assert.throws(() => readConfig(invalid));
  const disabled = new TestSigningKeys(readConfig(base));
  assert.equal(disabled.mode, "disabled");
  await assert.rejects(disabled.active());
  await assert.rejects(disabled.version(`test-${randomUUID()}`));
});

test("minimal Test credential JWS is independently verifiable and rejects tampering, extra claims, and wrong key material", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = new TestSigningKey(`test-${randomUUID()}`, pair.privateKey);
  const issued = new Date(Math.floor(Date.now() / 1000) * 1000);
  const row: CredentialRecord = { id: randomUUID(), account_id: randomUUID(), verification_id: randomUUID(), signing_key_id: key.id,
    state: "active", issued_at: issued, expires_at: new Date(issued.getTime() + 300000), revoked_at: null };
  const signed = await signCredential(row, key, new AbortController().signal);
  const publicKey = await importJWK(signed.publicKey, "RS256");
  const verified = await jwtVerify(signed.token, publicKey, { algorithms: ["RS256"], issuer: CREDENTIAL_ISSUER, audience: CREDENTIAL_AUDIENCE, typ: CREDENTIAL_TYPE });
  assert.deepEqual(verified.payload, credentialClaims(row));
  assert.equal(credentialKeyId(signed.token), key.id);
  assert.equal(JSON.stringify(decodeJwt(signed.token)).includes(row.account_id), false);
  assert.equal(JSON.stringify(decodeJwt(signed.token)).includes(row.verification_id), false);
  const parts = signed.token.split(".");
  const signature = Buffer.from(parts[2]!, "base64url");
  signature[0] = signature[0]! ^ 1;
  await assert.rejects(verifyCredentialSignature(`${parts[0]}.${parts[1]}.${signature.toString("base64url")}`, signed.publicKey));
  await assert.rejects(verifyCredentialSignature(`${parts[0]}.${Buffer.from(JSON.stringify({ ...credentialClaims(row), test: false })).toString("base64url")}.${parts[2]}`, signed.publicKey));
  const extra = await new SignJWT({ ...credentialClaims(row), arbitrary: randomUUID() }).setProtectedHeader({ alg: "RS256", typ: CREDENTIAL_TYPE, kid: key.id }).sign(pair.privateKey);
  await assert.rejects(verifyCredentialSignature(extra, signed.publicKey));
  for (const header of [{ alg: "none", typ: CREDENTIAL_TYPE, kid: key.id }, { alg: "HS256", typ: CREDENTIAL_TYPE, kid: key.id },
    { alg: "RS256", typ: CREDENTIAL_TYPE, kid: key.id, jku: "https://invalid.example/keys" },
  ]) assert.throws(() => credentialKeyId(`${Buffer.from(JSON.stringify(header)).toString("base64url")}.${parts[1]}.${parts[2]}`));
  await assert.rejects(publicVerificationKey(key.id, { ...signed.publicKey, d: randomUUID() }));
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(signCredential(row, { ...key, id: key.id, algorithm: "RS256", mode: "test", publicKey: () => key.publicKey(),
    sign: async (input) => { const { sign } = await import("node:crypto"); return sign("sha256", input, other.privateKey); } }, new AbortController().signal));
});

test("expiration has an exact UTC boundary and terminal states stay terminal after time changes", () => {
  const row: CredentialRecord = { id: randomUUID(), account_id: randomUUID(), verification_id: randomUUID(), signing_key_id: `test-${randomUUID()}`,
    state: "active", issued_at: new Date("2026-01-01T00:00:00Z"), expires_at: new Date("2026-01-01T00:05:00Z"), revoked_at: null };
  assert.equal(credentialStatus(row, new Date("2026-01-01T00:04:59.999Z")), "active");
  assert.equal(credentialStatus(row, row.expires_at), "expired");
  assert.equal(credentialStatus({ ...row, state: "revoked" }, row.issued_at), "revoked");
  assert.equal(credentialStatus({ ...row, state: "superseded" }, row.issued_at), "superseded");
});

test("managed signing delegates a SHA-256 digest and version to KMS/HSM without private-key access", async () => {
  const input = Buffer.from(randomUUID());
  const version = randomUUID();
  const signature = Buffer.from(randomUUID());
  let calls = 0;
  const key = new ManagedSigningKey("kms-version-1", version, {
    publicKey: async () => ({ kty: "RSA", n: "public", e: "AQAB" }),
    signDigest: async (request) => {
      calls++;
      assert.equal(request.version, version);
      assert.equal(request.algorithm, "RSASSA_PKCS1_V1_5_SHA_256");
      assert.deepEqual(request.digest, createHash("sha256").update(input).digest());
      return signature;
    },
  });
  assert.equal(key.mode, "production");
  assert.deepEqual(await key.sign(input, new AbortController().signal), signature);
  assert.equal(calls, 1);
});
