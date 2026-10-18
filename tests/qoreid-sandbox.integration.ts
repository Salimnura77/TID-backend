import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config/runtime-config";
import { QoreidProvider } from "../src/verification/qoreid-provider";

// Explicit opt-in, provider-published Test inputs, no database or application
// users. Never print token/request/response/exception values in assertion output.
test("QoreID Test NIN endpoint verifies its published Test input and rejects a name mismatch", {
  skip: process.env.TRUEID_RUN_QOREID_SANDBOX_TESTS !== "true" ? "QoreID Test integration opt-in is not configured" : false,
  timeout: 15000,
}, async () => {
  const config = readConfig(process.env);
  assert(config.qoreid, "QoreID Test configuration is required");
  const statuses: { stage: "authentication" | "nin"; status: number }[] = [];
  const provider = new QoreidProvider(config.qoreid, async (url, init) => {
    const response = await fetch(url, init);
    statuses.push({ stage: url === "https://api.qoreid.com/token" ? "authentication" : "nin", status: response.status });
    return response;
  });
  const exact = await provider.verify({ nin: "63184876213", firstname: "Bunch", lastname: "Dillon" }, AbortSignal.timeout(5000));
  assert.equal(exact.outcome, "verified", `Published QoreID Test input must verify. Safe diagnostics: ${JSON.stringify(statuses)}; ${exact.reason}`);
  const mismatch = await provider.verify({ nin: "63184876213", firstname: "Guion", lastname: "Audi" }, AbortSignal.timeout(5000));
  assert.equal(mismatch.outcome, "unable_to_verify", "Mismatched QoreID Test names must not verify");
});
