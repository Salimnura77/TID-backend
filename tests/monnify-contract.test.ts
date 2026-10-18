import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MonnifyContractClient } from "../src/verification/monnify-contract-client";
import type { MonnifyContractCredentials, MonnifyContractTransport } from "../src/verification/monnify-contract-client";
import { mapMonnifyBvnResponse, mapMonnifyNinResponse } from "../src/verification/monnify-contract";

// Official documentation examples only, NOT a provider Sandbox facility or seeded
// identity profiles. These contract tests always inject an in-process transport.
// https://developers.monnify.com/docs/verification-api/verifying-your-customers
const nin = { nin: "98765432101", firstname: "John", lastname: "Doe" };
const bvn = { bvn: "12345678901", name: "John Doe", dateOfBirth: "01-Jan-1990", mobileNo: "08012345678" };
const credentials: MonnifyContractCredentials = { apiKey: `MK_TEST_${randomUUID()}`, secretKey: randomUUID() };
const success = (responseBody: unknown) => ({ requestSuccessful: true, responseCode: "0", responseMessage: "success", responseBody });
const ninBody = () => ({ nin: nin.nin, firstName: nin.firstname, lastName: nin.lastname, ninInformationMatch: true });
const bvnBody = () => ({ ...bvn, bvnInformationMatch: true });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const auth = () => json(success({ accessToken: randomUUID(), expiresIn: 3600 }));
const signal = () => new AbortController().signal;
const transport = (request: MonnifyContractTransport["request"]): MonnifyContractTransport => ({ mode: "contract-test", request });

test("Monnify mapping requires matching evidence rather than transport success and removes every response value", () => {
  const marker = randomUUID();
  assert.deepEqual(mapMonnifyNinResponse(success({ ...ninBody(), photo: marker, secret: marker }), nin), { outcome: "verified", reason: "exact_match" });
  assert.deepEqual(mapMonnifyBvnResponse(success({ ...bvnBody(), secret: marker }), bvn), { outcome: "verified", reason: "exact_match" });
  for (const value of [null, {}, [], { requestSuccessful: true }, success({}), { ...success(ninBody()), responseCode: 0 },
    { ...success(ninBody()), requestSuccessful: "true" }, success({ ...ninBody(), ninInformationMatch: "true" }),
    success({ ...ninBody(), firstName: undefined }), success({ ...ninBody(), nin: bvn.bvn }),
  ]) assert.equal(mapMonnifyNinResponse(value, nin).outcome, "provider_unavailable");
  for (const value of [success({ ...bvnBody(), bvnInformationMatch: undefined }), success({ ...bvnBody(), bvnInformationMatch: "true" }),
    success({ ...bvnBody(), bvn: nin.nin }), success({ ...bvnBody(), mobileNo: undefined }),
    success({ ...bvnBody(), dateOfBirth: "31-Feb-1990" }),
  ]) assert.equal(mapMonnifyBvnResponse(value, bvn).outcome, "provider_unavailable");
  for (const result of [mapMonnifyNinResponse(success(ninBody()), nin), mapMonnifyBvnResponse(success(bvnBody()), bvn)]) {
    assert.deepEqual(Object.keys(result).sort(), ["outcome", "reason"]);
    for (const value of [...Object.values(nin), ...Object.values(bvn), marker]) assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test("Monnify mismatches and incomplete evidence cannot create an exact verified outcome", () => {
  assert.deepEqual(mapMonnifyNinResponse(success({ ...ninBody(), ninInformationMatch: false }), nin), { outcome: "unable_to_verify", reason: "no_match" });
  assert.deepEqual(mapMonnifyNinResponse(success({ ...ninBody(), firstName: nin.lastname, lastName: nin.firstname }), nin), { outcome: "needs_review", reason: "transposed_match" });
  assert.deepEqual(mapMonnifyNinResponse(success({ ...ninBody(), firstName: randomUUID() }), nin), { outcome: "needs_review", reason: "partial_match" });
  assert.deepEqual(mapMonnifyNinResponse(success({ ...ninBody(), firstName: randomUUID(), lastName: randomUUID() }), nin), { outcome: "unable_to_verify", reason: "identity_mismatch" });
  assert.deepEqual(mapMonnifyBvnResponse(success({ ...bvnBody(), bvnInformationMatch: false }), bvn), { outcome: "unable_to_verify", reason: "no_match" });
  for (const override of [{ name: randomUUID() }, { dateOfBirth: "02-Jan-1990" }, { mobileNo: "08012345679" }]) {
    assert.deepEqual(mapMonnifyBvnResponse(success({ ...bvnBody(), ...override }), bvn), { outcome: "unable_to_verify", reason: "identity_mismatch" });
  }
});

test("the offline client prepares only documented authentication/NIN/BVN requests and sends minimum fields", async () => {
  const bearer = randomUUID();
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new MonnifyContractClient(credentials, transport(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/login")) return json(success({ accessToken: bearer, expiresIn: 3600 }));
    return json(success(url.endsWith("/nin-verification") ? ninBody() : bvnBody()));
  }));
  assert.equal((await client.verifyNin(nin, signal())).outcome, "verified");
  assert.equal((await client.verifyBvn(bvn, signal())).outcome, "verified");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://sandbox.monnify.com/api/v1/auth/login", "https://sandbox.monnify.com/api/v1/vas/nin-verification",
    "https://sandbox.monnify.com/api/v1/auth/login", "https://sandbox.monnify.com/api/v1/vas/bvn-details-match",
  ]);
  const expectedBasic = `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.secretKey}`).toString("base64")}`;
  assert.equal(new Headers(calls[0]!.init.headers).get("Authorization"), expectedBasic);
  assert.equal(calls[0]!.init.body, undefined);
  assert.equal(new Headers(calls[1]!.init.headers).get("Authorization"), `Bearer ${bearer}`);
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { nin: nin.nin });
  assert.deepEqual(JSON.parse(calls[3]!.init.body as string), bvn);
  for (const call of calls) {
    assert.equal(call.init.method, "POST"); assert.equal(call.init.redirect, "error"); assert(call.init.signal);
    for (const value of [...Object.values(nin), ...Object.values(bvn)]) assert.equal(call.url.includes(value), false);
  }
  // True private fields prevent accidental serialization of ephemeral secrets.
  assert.equal(JSON.stringify(client), "{}");
});

test("the client snapshots identity inputs before authentication can yield", async () => {
  const submitted = { ...nin };
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  const client = new MonnifyContractClient(credentials, transport(async () => {
    if (++count === 1) { await ready; return auth(); }
    return json(success(ninBody()));
  }));
  const result = client.verifyNin(submitted, signal());
  submitted.nin = bvn.bvn; submitted.firstname = randomUUID();
  release!();
  assert.equal((await result).outcome, "verified");
});

test("invalid inputs and non-contract or Live-shaped configuration never reach a transport", async () => {
  let calls = 0;
  const mock = transport(async () => { calls++; return auth(); });
  const client = new MonnifyContractClient(credentials, mock);
  await client.verifyNin({ ...nin, nin: "invalid" }, signal());
  await client.verifyNin({ ...nin, firstname: "\r\n" }, signal());
  for (const override of [{ dateOfBirth: "31-Feb-1990" }, { dateOfBirth: "01-Unknown-1990" }, { dateOfBirth: "01-Jan-2990" },
    { bvn: "invalid" }, { name: " " }, { mobileNo: "\n" + bvn.mobileNo }]) {
    await client.verifyBvn({ ...bvn, ...override }, signal());
  }
  assert.equal(calls, 0);
  const marker = randomUUID();
  for (const mode of ["live", "production", "sandbox"]) {
    assert.throws(() => new MonnifyContractClient(credentials, { ...mock, mode } as MonnifyContractTransport));
  }
  assert.throws(() => new MonnifyContractClient({ apiKey: `MK_LIVE_${marker}`, secretKey: marker }, mock), (error: unknown) => {
    assert(error instanceof Error); assert.equal(error.message.includes(marker), false); return true;
  });
});

test("authentication/verification failures and exceptions yield fixed safe codes without retries", async () => {
  const marker = randomUUID();
  for (const stage of ["authentication", "verification"] as const) for (const status of [201, 302, 400, 401, 403, 429, 500, 503, 504]) {
    let calls = 0;
    const client = new MonnifyContractClient(credentials, transport(async () => {
      calls++;
      if (stage === "verification" && calls === 1) return auth();
      return json({ message: marker, ...bvn }, status);
    }));
    const result = await client.verifyBvn(bvn, signal());
    assert.notEqual(result.outcome, "verified");
    assert.equal(calls, stage === "authentication" ? 1 : 2);
    if (status === 401 || status === 403) assert.equal(result.reason, "provider_access_denied");
    if (status === 429) assert.equal(result.reason, "provider_rate_limited");
    if (status === 504) assert.equal(result.outcome, "timeout");
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  const client = new MonnifyContractClient(credentials, transport(async () => { throw new Error(marker + JSON.stringify(bvn)); }));
  assert.deepEqual(await client.verifyBvn(bvn, signal()), { outcome: "provider_unavailable", reason: "provider_unavailable" });
});

test("malformed/oversized bodies and unsafe tokens cannot escape as verification results", async () => {
  for (const body of [json(success({ accessToken: "\r\n" + nin.nin, expiresIn: 3600 })),
    json(success({ accessToken: randomUUID(), expiresIn: "3600" })), json(success({ accessToken: randomUUID(), expiresIn: -1 })),
    new Response("not-json", { headers: { "Content-Type": "application/json" } }),
    new Response("sensitive-html", { headers: { "Content-Type": "text/html" } }),
    new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } }),
    new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "65537" } }),
  ]) {
    let calls = 0;
    const client = new MonnifyContractClient(credentials, transport(async () => { calls++; return body; }));
    const result = await client.verifyNin(nin, signal());
    assert.equal(result.outcome, "provider_unavailable"); assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(nin.nin), false);
  }
  for (const response of [json(success({ ...bvnBody(), bvnInformationMatch: "true" })),
    new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } })]) {
    let calls = 0;
    const client = new MonnifyContractClient(credentials, transport(async () => ++calls === 1 ? auth() : response));
    assert.equal((await client.verifyBvn(bvn, signal())).outcome, "provider_unavailable");
    assert.equal(calls, 2);
  }
});

test("a contract transport that never settles is aborted within the total deadline", { timeout: 15000 }, async () => {
  let calls = 0;
  let aborted = false;
  const client = new MonnifyContractClient(credentials, transport(async (_url, init) => {
    calls++; init.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise<Response>(() => undefined);
  }));
  assert.deepEqual(await client.verifyNin(nin, signal()), { outcome: "timeout", reason: "provider_timeout" });
  assert.equal(aborted, true); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await client.verifyNin(nin, controller.signal)).outcome, "timeout");
  assert.equal(calls, 1);
});
