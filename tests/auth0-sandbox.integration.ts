import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import supertest from "supertest";
import { AppModule } from "../src/app.module";
import { APP_CONFIG, readConfig } from "../src/config/runtime-config";
import { DatabaseService } from "../src/database/database.service";
import { configureHttp } from "../src/http/configure-http";
import { RequestContext } from "../src/logging/request-context";
import { StructuredLogger } from "../src/logging/structured-logger";
import { EmbeddedDatabase } from "./auth-support";

// Explicit opt-in only. Tokens must come from two authorized Auth0 developer-tenant
// sessions using the native Authorization Code + PKCE flow; never generate users here.
test("Auth0 developer tenant access tokens provision isolated accounts through the real verifier", {
  skip: process.env.TRUEID_RUN_AUTH0_SANDBOX_TESTS !== "true" ? "Auth0 sandbox opt-in and authorized tokens are not configured" : false,
}, async () => {
  const tokenA = process.env.TRUEID_AUTH0_TEST_ACCESS_TOKEN_A;
  const tokenB = process.env.TRUEID_AUTH0_TEST_ACCESS_TOKEN_B;
  assert(typeof tokenA === "string" && tokenA.length > 0, "Sandbox token A is required");
  assert(typeof tokenB === "string" && tokenB.length > 0, "Sandbox token B is required");
  const config = readConfig(process.env);
  assert(config.auth0, "Auth0 sandbox configuration is required");
  const database = new EmbeddedDatabase();
  await database.initialize();
  const logs: string[] = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config)
    .overrideProvider(DatabaseService).useValue(database)
    .overrideProvider(StructuredLogger).useFactory({ inject: [RequestContext], factory: (context: RequestContext) => new StructuredLogger("debug", context, (line) => logs.push(line)) })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureHttp(app, config);
  await app.init();
  const request = supertest(app.getHttpServer());
  try {
    // Check statuses separately: assertion output must never dump provider payloads/tokens.
    const a = await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({});
    const b = await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).send({});
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.created, true);
    assert.equal(b.body.created, true, "Two different sandbox subjects are required");
    const aId: unknown = a.body.account?.id;
    const bId: unknown = b.body.account?.id;
    assert(typeof aId === "string" && typeof bId === "string");
    assert(aId !== bId, "Sandbox accounts must be distinct");
    const resume = await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({});
    assert.equal(resume.status, 200);
    assert(resume.body.account.id === aId);
    assert.equal(resume.body.created, false);
    const denied = await request.get(`/api/v1/users/me?accountId=${aId}`).set("Authorization", `Bearer ${tokenB}`);
    assert.equal(denied.status, 400);
    assert.equal(denied.text.includes(aId), false);
    assert.equal(logs.join("").includes(tokenA), false);
    assert.equal(logs.join("").includes(tokenB), false);
  } finally { await app.close(); await database.close(); }
});
