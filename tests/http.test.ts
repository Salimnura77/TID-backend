import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Body, Controller, HttpException, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { IsIn } from "class-validator";
import supertest from "supertest";
import { AppModule } from "../src/app.module";
import { APP_CONFIG, readConfig } from "../src/config/runtime-config";
import { DatabaseService } from "../src/database/database.service";
import { configureHttp } from "../src/http/configure-http";
import { StructuredLogger } from "../src/logging/structured-logger";
import { RequestContext } from "../src/logging/request-context";
import { Public } from "../src/auth/public.decorator";

const sentinel = "fixture-secret-must-never-be-returned";

// These endpoints exist exclusively in the test module.
class TestDto {
  @IsIn(["sample"], { message: "Invalid sensitive value: $value" })
  label!: string;
}
@Public() // Parser/DTO tests only; protected account routes are tested separately.
@Controller("test")
class TestController {
  @Post("validate")
  validate(@Body() dto: TestDto): { accepted: boolean } { return { accepted: dto.label === "sample" }; }
  @Post("error")
  error(): never { throw new Error(sentinel); }
  @Post("http-error")
  httpError(): never { throw new HttpException({ message: sentinel, token: sentinel }, 403); }
}

test("HTTP foundation rejects unsafe input and returns only safe error metadata", async (t) => {
  let ready = true;
  const logs: Record<string, unknown>[] = [];
  const config = readConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://local:test@localhost/trueid", TRUEID_CORS_ORIGINS: "http://localhost:8081" });
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [TestController] })
    .overrideProvider(APP_CONFIG).useValue(config)
    .overrideProvider(DatabaseService).useValue({ assertReady: async () => { if (!ready) throw new Error(sentinel); } })
    .overrideProvider(StructuredLogger).useFactory({
      inject: [RequestContext],
      factory: (context: RequestContext) => new StructuredLogger("debug", context, (line) => logs.push(JSON.parse(line))),
    })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureHttp(app, config);
  await app.init();
  const request = supertest(app.getHttpServer());
  try {
    await t.test("health preserves the pilot shape; readiness fails closed and liveness stays available", async () => {
      const ok = await request.get("/api/v1/health").expect(200);
      assert.deepEqual(ok.body, { demo: true, status: "ready" });
      assert.equal(ok.headers["x-powered-by"], undefined);
      assert.equal(ok.headers["x-content-type-options"], "nosniff");
      ready = false;
      const down = await request.get("/api/v1/health").expect(503);
      assert.equal(down.body.error.code, "service_unavailable");
      assert.equal(down.body.requestId, down.headers["x-request-id"]);
      assert.equal(down.text.includes(sentinel), false);
      await request.get("/api/v1/health/live").expect(200, { demo: true, status: "alive" });
    });
    await t.test("DTO validation rejects unknown fields, invalid values and implicit conversion", async () => {
      await request.post("/api/v1/test/validate").send({ label: "sample" }).expect(201, { accepted: true });
      for (const body of [{ label: "sample", secret: sentinel }, { label: sentinel }, { label: 123 }, {}]) {
        const response = await request.post("/api/v1/test/validate").send(body).expect(400);
        assert.equal(response.body.error.code, "invalid_request");
        assert.equal(response.text.includes(sentinel), false);
      }
    });
    await t.test("malformed and oversized JSON do not leak request contents", async () => {
      const bad = await request.post("/api/v1/test/validate").set("Content-Type", "application/json").send(`{"label":"${sentinel}"`).expect(400);
      assert.equal(bad.body.error.code, "invalid_request");
      assert.equal(bad.text.includes(sentinel), false);
      assert.equal(bad.body.requestId, bad.headers["x-request-id"]);
      const large = await request.post("/api/v1/test/validate").send({ label: sentinel.repeat(1000) }).expect(413);
      assert.equal(large.body.error.code, "payload_too_large");
      assert.equal(large.text.includes(sentinel), false);
      assert.equal(large.body.requestId, large.headers["x-request-id"]);
    });
    await t.test("CORS allows the exact configured origin and denies others", async () => {
      const allowed = await request.get("/api/v1/health/live").set("Origin", "http://localhost:8081").expect(200);
      assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:8081");
      assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
      assert.equal(allowed.headers["access-control-expose-headers"], "X-Request-Id");
      const denied = await request.get("/api/v1/health/live").set("Origin", "http://localhost:9999").expect(403);
      assert.equal(denied.body.error.code, "origin_not_allowed");
      assert.equal(denied.headers["access-control-allow-origin"], undefined);
      assert.equal(denied.body.requestId, denied.headers["x-request-id"]);
    });
    await t.test("unexpected errors, framework errors and URLs never expose details", async () => {
      for (const [route, status, code] of [["error", 500, "internal_error"], ["http-error", 403, "forbidden"]] as const) {
        const response = await request.post(`/api/v1/test/${route}`).expect(status);
        assert.equal(response.body.error.code, code);
        assert.equal(response.text.includes(sentinel), false);
      }
      const missing = await request.get(`/api/v1/missing?token=${sentinel}`).expect(404);
      assert.equal(missing.body.error.code, "not_found");
      assert.equal(missing.text.includes(sentinel), false);
    });
    await t.test("URI versioning rejects unversioned/unknown versions and unimplemented domain routes remain absent", async () => {
      for (const path of ["/api/health", "/api/v2/health", "/api/v1/auth", "/api/v1/users", "/api/v1/verification", "/api/v1/partners", "/api/v1/consent", "/api/v1/audit", "/api/v1/testing/pair"]) {
        await request.get(path).expect(404);
        await request.post(path).send({}).expect(404);
      }
    });
    await t.test("account endpoints deny access when Auth0 is unconfigured", async () => {
      await request.post("/api/v1/users/me").send({}).expect(401);
      const syntax = Array.from({ length: 3 }, () => randomUUID().replaceAll("-", "")).join(".");
      const denied = await request.get("/api/v1/users/me").set("Authorization", `Bearer ${syntax}`).expect(503);
      assert.equal(denied.body.error.code, "authentication_unavailable");
      assert.equal(denied.body.requestId, denied.headers["x-request-id"]);
      assert.equal(denied.text.includes(syntax), false);
    });
    await t.test("request IDs are generated independently and correlate redacted completion/error logs", async () => {
      const results = await Promise.all([0, 1, 2].map(() => request.get(`/api/v1/health/live?token=${sentinel}`)
        .set("X-Request-Id", sentinel).set("Authorization", `Bearer ${sentinel}`).set("Cookie", `session=${sentinel}`).expect(200)));
      const ids = results.map((response) => response.headers["x-request-id"]);
      assert.equal(new Set(ids).size, 3);
      for (const id of ids) {
        assert(typeof id === "string");
        assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        const entry = logs.find((log) => log.event === "http_request" && log.requestId === id);
        assert(entry);
        assert.equal(entry.route, "health_liveness");
        assert.equal(entry.statusCode, 200);
      }
      const errors = logs.filter((log) => log.event === "http_error");
      assert(errors.length > 0);
      for (const entry of errors) {
        assert.equal(typeof entry.requestId, "string");
        assert(logs.some((log) => log.event === "http_request" && log.requestId === entry.requestId));
      }
      assert.equal(JSON.stringify(logs).includes(sentinel), false);
      assert.equal(JSON.stringify(logs).includes("Bearer"), false);
    });
  } finally { await app.close(); }
});
