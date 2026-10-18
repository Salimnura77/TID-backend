import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import type { JWK } from "jose";
import { ApiError } from "../http/api-error";
import { credentialClaims, CREDENTIAL_AUDIENCE, CREDENTIAL_ISSUER, CREDENTIAL_TYPE } from "./credential";
import type { CredentialRecord } from "./credential";
import type { SigningKey } from "./signing-key";
import { TEST_KEY_ID } from "./test-signing-keys";

export async function publicVerificationKey(id: string, value: JWK): Promise<JWK> {
  if (!TEST_KEY_ID.test(id) || value.kty !== "RSA" || typeof value.n !== "string" || typeof value.e !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(value.n) || !/^[A-Za-z0-9_-]+$/.test(value.e) ||
      ["d", "p", "q", "dp", "dq", "qi", "k"].some((field) => Object.hasOwn(value, field)) ||
      (value.kid !== undefined && value.kid !== id)) throw new ApiError(503, "signing_unavailable");
  const publicKey: JWK = { kty: "RSA", n: value.n, e: value.e, kid: id, alg: "RS256", use: "sig" };
  const imported = await importJWK(publicKey, "RS256");
  if (imported instanceof Uint8Array || imported.type !== "public" ||
      !("modulusLength" in imported.algorithm) || typeof imported.algorithm.modulusLength !== "number" || imported.algorithm.modulusLength < 2048) {
    throw new ApiError(503, "signing_unavailable");
  }
  return publicKey;
}

export async function signCredential(record: CredentialRecord, key: SigningKey, signal: AbortSignal): Promise<{ token: string; publicKey: JWK }> {
  if (key.mode !== "test" || key.algorithm !== "RS256" || key.id !== record.signing_key_id) throw new ApiError(503, "signing_unavailable");
  const publicKey = await publicVerificationKey(key.id, await key.publicKey());
  signal.throwIfAborted();
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: CREDENTIAL_TYPE, kid: key.id })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(credentialClaims(record))).toString("base64url");
  // RFC 7515 compact signing input. The managed signing interface receives bytes;
  // production private material is never imported into this service.
  const input = `${header}.${payload}`;
  const signature = await key.sign(Buffer.from(input, "ascii"), signal);
  signal.throwIfAborted();
  const token = `${input}.${Buffer.from(signature).toString("base64url")}`;
  // Check the signer returned a valid signature for its advertised public key
  // before any reference becomes active, including KMS/HSM adapter failures.
  await compactVerify(token, await importJWK(publicKey, "RS256"), { algorithms: ["RS256"] });
  return { token, publicKey };
}

export function credentialKeyId(token: string): string {
  try {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || header.typ !== CREDENTIAL_TYPE || typeof header.kid !== "string" ||
        !TEST_KEY_ID.test(header.kid) || Object.keys(header).sort().join(",") !== "alg,kid,typ") throw new Error();
    return header.kid;
  } catch { throw new ApiError(400, "credential_invalid"); }
}

export async function verifyCredentialSignature(token: string, publicKey: JWK): Promise<Record<string, unknown>> {
  try {
    const result = await compactVerify(token, await importJWK(publicKey, "RS256"), { algorithms: ["RS256"] });
    const claims: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(result.payload));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error();
    const body = claims as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "aud,exp,iat,iss,jti,test,verification" ||
        body.iss !== CREDENTIAL_ISSUER || body.aud !== CREDENTIAL_AUDIENCE || body.test !== true || body.verification !== "verified" ||
        typeof body.jti !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.jti) ||
        !Number.isSafeInteger(body.iat) || !Number.isSafeInteger(body.exp) || (body.exp as number) <= (body.iat as number)) throw new Error();
    return body;
  } catch { throw new ApiError(400, "credential_invalid"); }
}
