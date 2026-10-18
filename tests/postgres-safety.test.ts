import assert from "node:assert/strict";
import { test } from "node:test";
import { postgresTestSettings } from "./postgres-support";

test("TCP suite refuses missing, remote, option-bearing and non-dedicated databases without leaking connection details", () => {
  const sentinel = "connection-secret-must-not-appear";
  for (const value of [undefined, `postgres://ci:${sentinel}@127.0.0.1/trueid`,
    `postgres://ci:${sentinel}@remote.example/trueid_ci`,
    `postgres://ci:${sentinel}@localhost/trueid_ci?sslmode=disable`,
    `postgres://ci:${sentinel}@localhost/trueid_ci_other`]) {
    assert.throws(() => postgresTestSettings(value ? { TRUEID_TEST_DATABASE_URL: value } : {}), (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes(sentinel));
      assert.match(error.message, /dedicated loopback trueid_ci/);
      return true;
    });
  }
  assert.throws(() => postgresTestSettings({ DATABASE_URL: "postgres://ci:test@localhost/trueid_ci" }));
});

test("TCP suite creates a distinct database target and ignores provider/production environment settings", () => {
  const env = { TRUEID_TEST_DATABASE_URL: "postgres://ci:local_test_only@127.0.0.1:55432/trueid_ci",
    NODE_ENV: "production", TRUEID_QOREID_MODE: "live", TRUEID_MONNIFY_MODE: "live" };
  const one = postgresTestSettings(env);
  const two = postgresTestSettings(env);
  assert.match(one.databaseName, /^trueid_ci_[a-f0-9]{32}$/);
  assert.notEqual(one.databaseName, two.databaseName);
  assert.equal(new URL(one.admin.databaseUrl).pathname, "/trueid_ci");
  assert.equal(new URL(one.isolated.databaseUrl).pathname, `/${one.databaseName}`);
  assert.equal(one.isolated.environment, "test");
  assert.equal(one.isolated.qoreid, undefined);
  assert.equal(one.isolated.auth0, undefined);
  assert.equal(one.isolated.testSigning, undefined);
});
