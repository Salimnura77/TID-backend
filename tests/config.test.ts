import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config/runtime-config";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://local:test@127.0.0.1:55432/trueid" };

test("local configuration fails closed for production, nonlocal databases and URL options", () => {
  assert.equal(readConfig(base).host, "127.0.0.1");
  assert.equal(readConfig(base).port, 4200);
  assert.deepEqual(readConfig(base).corsOrigins, []);
  assert.equal(readConfig(base).logLevel, "info");
  const sentinel = "fixture-secret-not-for-errors";
  for (const env of [
    { ...base, NODE_ENV: "production" },
    { ...base, DATABASE_URL: undefined },
    { ...base, DATABASE_URL: `postgresql://user:${sentinel}@remote.example/trueid` },
    { ...base, DATABASE_URL: "sqlite:///tmp/trueid" },
    { ...base, DATABASE_URL: `${base.DATABASE_URL}?sslmode=no-verify` },
    { ...base, DATABASE_URL: "postgresql://127.0.0.1/trueid" },
    { ...base, TRUEID_PORT: sentinel },
    { ...base, TRUEID_PORT: "0" },
    { ...base, TRUEID_PORT: "65536" },
    { ...base, TRUEID_PORT: "4200.5" },
    { ...base, TRUEID_LOG_LEVEL: sentinel },
  ]) {
    assert.throws(() => readConfig(env), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message.includes(sentinel), false);
      assert.match(error.message, /Invalid local configuration/);
      return true;
    });
  }
});

test("CORS configuration accepts exact local origins and rejects wildcards and token-bearing URLs", () => {
  assert.deepEqual(readConfig({ ...base, TRUEID_CORS_ORIGINS: "http://localhost:8081,http://127.0.0.1:8081" }).corsOrigins,
    ["http://localhost:8081", "http://127.0.0.1:8081"]);
  for (const origin of ["*", "null", "https://remote.example", "http://localhost:8081/", "http://user:secret@localhost:8081", "http://localhost:8081?token=secret", "http://localhost:8081,http://localhost:8081"]) {
    assert.throws(() => readConfig({ ...base, TRUEID_CORS_ORIGINS: origin }));
  }
});
