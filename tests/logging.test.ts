import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestContext } from "../src/logging/request-context";
import { StructuredLogger } from "../src/logging/structured-logger";

test("structured logging omits sensitive and arbitrary metadata, including values under allowed field names", () => {
  const sentinel = "fixture-secret-never-log";
  const lines: string[] = [];
  const logger = new StructuredLogger("debug", new RequestContext(), (line) => lines.push(line));
  const unsafe = {
    requestId: sentinel, method: sentinel, route: sentinel, code: sentinel,
    port: sentinel, count: sentinel, statusCode: sentinel, durationMs: Infinity,
    headers: { authorization: sentinel, cookie: sentinel }, body: { fullName: sentinel },
    url: `/?token=${sentinel}`, databaseUrl: sentinel, exception: new Error(sentinel),
    credential: sentinel, attributes: { nationality: sentinel },
    toJSON: () => { throw new Error("Arbitrary input must never be serialized"); },
  };
  logger.emit("http_request", unsafe);
  logger.emit("http_error", unsafe);
  logger.emit("startup_failed", unsafe);
  logger.emit("service_started", unsafe);
  logger.emit("migrations_applied", unsafe);
  logger.emit("database_unavailable", unsafe);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.equal(line.includes(sentinel), false);
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).sort(), ["event", "level", "time"]);
    assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  }
});

test("log thresholds keep failures visible and HTTP 5xx errors have error severity", () => {
  const entries: Record<string, unknown>[] = [];
  const logger = new StructuredLogger("error", new RequestContext(), (line) => entries.push(JSON.parse(line)));
  logger.emit("service_started", { port: 4200 });
  logger.emit("http_error", { statusCode: 400, code: "invalid_request" });
  logger.emit("http_error", { statusCode: 503, code: "service_unavailable" });
  logger.emit("startup_failed");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.level, "error");
  assert.equal(entries[0]!.code, "service_unavailable");
  assert.equal(entries[1]!.event, "startup_failed");
});

test("request context isolates concurrent asynchronous work and is cleared outside a request", async () => {
  const context = new RequestContext();
  const entries: Record<string, unknown>[] = [];
  const logger = new StructuredLogger("info", context, (line) => entries.push(JSON.parse(line)));
  const ids = await Promise.all([15, 1, 8].map((delay) => context.withRequest(async () => {
    const id = context.requestId;
    await new Promise((resolve) => setTimeout(resolve, delay));
    assert.equal(context.requestId, id);
    logger.emit("http_request", { statusCode: 200, method: "GET", route: "health_liveness" });
    return id;
  })));
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(new Set(entries.map((entry) => entry.requestId)), new Set(ids));
  assert.equal(context.requestId, undefined);
});
