import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readConfig } from "../src/config/runtime-config";
import type { QoreidConfig } from "../src/config/runtime-config";
import { QoreidProvider, mapQoreidNinResponse } from "../src/verification/qoreid-provider";
import { safeResult } from "../src/verification/verification.provider";

// Provider-published Test input only. No application accounts or seed profiles.
const input = { nin: "63184876213", firstname: "Bunch", lastname: "Dillon" };
const config: QoreidConfig = { mode: "sandbox", route: "nin", testClientId: randomUUID(), testClientSecret: randomUUID() };
const resultBody = (match = "EXACT_MATCH", firstname = true, lastname = true) => ({
  status: { state: "complete", status: "verified" }, summary: { nin_check: { status: match, fieldMatches: { firstname, lastname } } },
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("QoreID configuration is all-or-none, Test-only, and redacts invalid configuration", () => {
  const base = { NODE_ENV: "test", DATABASE_URL: `postgresql://${randomUUID()}:${randomUUID()}@localhost/trueid` };
  const enabled = { ...base, TRUEID_QOREID_MODE: "sandbox", TRUEID_QOREID_ROUTE: "nin",
    TRUEID_QOREID_TEST_CLIENT_ID: config.testClientId, TRUEID_QOREID_TEST_CLIENT_SECRET: config.testClientSecret };
  assert.equal(readConfig(base).qoreid, undefined);
  assert.equal(readConfig(enabled).qoreid?.mode, "sandbox");
  for (const invalid of [
    { ...enabled, NODE_ENV: "production" }, { ...enabled, TRUEID_QOREID_MODE: "live" },
    { ...enabled, TRUEID_QOREID_ROUTE: "bvn" }, { ...enabled, TRUEID_QOREID_TEST_CLIENT_SECRET: "" },
    { ...enabled, TRUEID_QOREID_TEST_CLIENT_ID: "" }, { ...enabled, TRUEID_QOREID_TEST_CLIENT_SECRET: "\n" + config.testClientSecret },
    { ...enabled, TRUEID_QOREID_LIVE_CLIENT_SECRET: config.testClientSecret },
  ]) assert.throws(() => readConfig(invalid), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message.includes(config.testClientSecret), false);
    assert.equal(error.message.includes(config.testClientId), false);
    return true;
  });
});

test("QoreID outcome mapping requires exact required-name matches and removes all response data", () => {
  const privateResponse = { ...resultBody(), id: 130, applicant: input, nin: { nin: input.nin, photo: randomUUID() }, insight: [randomUUID()] };
  assert.deepEqual(mapQoreidNinResponse(privateResponse), { outcome: "verified", reason: "exact_match" });
  assert.deepEqual(mapQoreidNinResponse(resultBody("PARTIAL_MATCH", true, false)), { outcome: "needs_review", reason: "partial_match" });
  assert.deepEqual(mapQoreidNinResponse(resultBody("TRANSPOSED_MATCH")), { outcome: "needs_review", reason: "transposed_match" });
  assert.deepEqual(mapQoreidNinResponse(resultBody("NO_MATCH", false, false)), { outcome: "unable_to_verify", reason: "no_match" });
  assert.deepEqual(mapQoreidNinResponse({ status: { state: "complete", status: "id_mismatch" } }), { outcome: "unable_to_verify", reason: "identity_mismatch" });
  assert.deepEqual(mapQoreidNinResponse({ status: { state: "complete", status: "unverified" } }), { outcome: "unable_to_verify", reason: "provider_unverified" });
  assert.deepEqual(mapQoreidNinResponse({ status: { state: "in_progress", status: "in_progress" } }), { outcome: "needs_review", reason: "provider_pending" });
  for (const unsafe of [null, [], {}, { status: { state: "complete", status: "verified" } },
    resultBody("EXACT_MATCH", false), resultBody("unknown"),
    { ...resultBody(), status: { state: "pending", status: "verified" } },
    { ...resultBody(), summary: { nin_check: { status: "EXACT_MATCH", fieldMatches: { firstname: "true", lastname: true } } } },
  ]) assert.deepEqual(mapQoreidNinResponse(unsafe), { outcome: "provider_unavailable", reason: "invalid_response" });
  assert.deepEqual(safeResult({ outcome: "verified", reason: "exact_match", response: privateResponse }), { outcome: "verified", reason: "exact_match" });
  assert.equal(safeResult({ outcome: "verified", reason: input.nin }).outcome, "provider_unavailable");
});

test("QoreID uses only documented paths and minimum fields, with redirects denied", async () => {
  const bearer = randomUUID();
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new QoreidProvider(config, async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? json({ accessToken: bearer, tokenType: "Bearer", expiresIn: "7200 secs" }, 201) : json(resultBody());
  });
  assert.equal((await provider.verify(input, new AbortController().signal)).outcome, "verified");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://api.qoreid.com/token");
  assert.equal(calls[1]!.url, `https://api.qoreid.com/v1/ng/identities/nin/${input.nin}`);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { clientId: config.testClientId, secret: config.testClientSecret });
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { firstname: input.firstname, lastname: input.lastname });
  assert(calls.every((call) => call.init.redirect === "error" && call.init.signal));
});

test("unconfigured providers and non-Test inputs make no outgoing calls", async () => {
  let calls = 0;
  const transport = async () => { calls++; throw new Error("Must not call provider"); };
  await new QoreidProvider(undefined, transport).verify(input, new AbortController().signal);
  await new QoreidProvider(config, transport).verify({ ...input, nin: "0".repeat(11) }, new AbortController().signal);
  await new QoreidProvider(config, transport).verify({ ...input, firstname: randomUUID() }, new AbortController().signal);
  assert.equal(calls, 0);
});

test("provider auth failures, errors and timeouts expose only fixed outcomes and never retry", async () => {
  const privateMarker = randomUUID();
  for (const status of [400, 401, 403, 429, 500, 503, 302]) {
    let calls = 0;
    const provider = new QoreidProvider(config, async () => { calls++; return json({ token: privateMarker, message: input.nin }, status); });
    const result = await provider.verify(input, new AbortController().signal);
    assert.equal(result.outcome, "provider_unavailable");
    if (status === 401 || status === 403) assert.equal(result.reason, "provider_access_denied");
    else if (status === 429) assert.equal(result.reason, "provider_rate_limited");
    else assert.equal(result.reason, "provider_unavailable");
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(privateMarker), false);
  }
  let calls = 0;
  const failure = new QoreidProvider(config, async () => { calls++; throw new Error(privateMarker + input.nin); });
  assert.equal((await failure.verify(input, new AbortController().signal)).outcome, "provider_unavailable");
  assert.equal(calls, 1);
  const controller = new AbortController();
  const timeout = new QoreidProvider(config, async () => { controller.abort(); throw new Error(privateMarker); });
  assert.deepEqual(await timeout.verify(input, controller.signal), { outcome: "timeout", reason: "provider_timeout" });
  let count = 0;
  const gateway = new QoreidProvider(config, async () => ++count === 1 ? json({ accessToken: randomUUID(), tokenType: "Bearer" }, 201) : json({ message: privateMarker }, 504));
  assert.equal((await gateway.verify(input, new AbortController().signal)).outcome, "timeout");
});

test("malformed, oversized and unsafe token responses fail closed without leaking content", async () => {
  for (const body of [json({ accessToken: "\r\n" + input.nin, tokenType: "Bearer" }, 201),
    new Response(input.nin, { status: 201 }), new Response("x".repeat(1024 * 1024 + 1), { status: 201 }),
    json({ accessToken: randomUUID(), tokenType: "Basic" }, 201),
  ]) {
    let calls = 0;
    const result = await new QoreidProvider(config, async () => { calls++; return body; }).verify(input, new AbortController().signal);
    assert.equal(result.outcome, "provider_unavailable");
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(input.nin), false);
  }
});
