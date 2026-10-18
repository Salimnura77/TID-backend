import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import supertest from "supertest";
import { AppModule } from "../src/app.module";
import { ACCESS_TOKEN_VERIFIER } from "../src/auth/identity";
import { Auth0TokenVerifier } from "../src/auth/auth0-token-verifier";
import { APP_CONFIG } from "../src/config/runtime-config";
import { DatabaseService } from "../src/database/database.service";
import { configureHttp } from "../src/http/configure-http";
import { RequestContext } from "../src/logging/request-context";
import { StructuredLogger } from "../src/logging/structured-logger";
import { AccountRepository } from "../src/users/account.repository";
import { cryptoFixture, EmbeddedDatabase } from "./auth-support";

@Controller({ path: "protected-test", version: "1" })
class ProtectedTestController {
  @Get() protected(): { accepted: true } { return { accepted: true }; }
}

test("account creation/resumption and protected access enforce issuer/subject ownership", async (t) => {
  const fixture = await cryptoFixture();
  const database = new EmbeddedDatabase();
  await database.initialize();
  const logs: string[] = [];
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [ProtectedTestController] })
    .overrideProvider(APP_CONFIG).useValue(fixture.config)
    .overrideProvider(DatabaseService).useValue(database)
    .overrideProvider(ACCESS_TOKEN_VERIFIER).useValue(new Auth0TokenVerifier(fixture.config.auth0, fixture.key))
    .overrideProvider(StructuredLogger).useFactory({ inject: [RequestContext], factory: (context: RequestContext) => new StructuredLogger("debug", context, (line) => logs.push(line)) })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureHttp(app, fixture.config);
  await app.init();
  const request = supertest(app.getHttpServer());
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const tokenA = await fixture.token(subjectA);
  const tokenB = await fixture.token(subjectB);
  let accountA = "";
  let accountB = "";
  try {
    await t.test("health is explicitly public and every other registered route is protected by default", async () => {
      await request.get("/api/v1/health/live").expect(200);
      await request.get("/api/v1/health").expect(200);
      for (const path of ["/api/v1/users/me", "/api/v1/protected-test"]) {
        const denied = await request.get(path).expect(401);
        assert.equal(denied.headers["www-authenticate"], 'Bearer realm="TrueID"');
        assert.equal(denied.body.error.code, "unauthenticated");
      }
      await request.post("/api/v1/users/me").send({}).expect(401);
      for (const header of ["Basic token", "Bearer invalid", `Bearer ${tokenA},${tokenB}`]) {
        await request.post("/api/v1/users/me").set("Authorization", header).send({}).expect(401);
      }
      await request.post("/api/v1/users/me").set({ Authorization: [`Bearer ${tokenA}`, `Bearer ${tokenB}`] }).send({}).expect(401);
      const count = await database.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.accounts");
      assert.equal(count.rows[0]!.count, 0);
    });

    await t.test("an authorized first sign-in creates one minimal random account; later sign-ins resume it", async () => {
      await request.get("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).expect(404);
      const created = await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({}).expect(200);
      assert.equal(created.body.created, true);
      accountA = created.body.account.id;
      assert.match(accountA, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.equal(created.headers["cache-control"], "no-store");
      const resumed = await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({}).expect(200);
      assert.equal(resumed.body.created, false);
      assert.equal(resumed.body.account.id, accountA);
      const read = await request.get("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).expect(200);
      assert.deepEqual(read.body.account, created.body.account);
      assert.deepEqual(Object.keys(read.body.account).sort(), ["createdAt", "id", "status", "updatedAt"]);
      assert.notEqual(accountA, subjectA);
    });

    await t.test("another subject receives a different account and cannot select the first account", async () => {
      const created = await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).send({}).expect(200);
      accountB = created.body.account.id;
      assert.notEqual(accountB, accountA);
      for (const path of [`/api/v1/users/${accountA}`, `/api/v1/users/me?accountId=${accountA}`]) {
        const denied = await request.get(path).set("Authorization", `Bearer ${tokenB}`);
        assert.equal(denied.status, path.includes("?") ? 400 : 404);
        assert.equal(denied.text.includes(accountA), false);
      }
      await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).send({ accountId: accountA }).expect(400);
      await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).send({ issuer: fixture.config.auth0!.issuer, subject: subjectA }).expect(400);
      const own = await request.get("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).set("X-Account-Id", accountA).expect(200);
      assert.equal(own.body.account.id, accountB);
      assert.equal(own.text.includes(accountA), false);
    });

    await t.test("untrusted token claims do not create accounts or bypass permissions", async () => {
      for (const claims of [{ aud: randomUUID() }, { client_id: randomUUID() }, { exp: 1 }]) {
        await request.post("/api/v1/users/me").set("Authorization", `Bearer ${await fixture.token(randomUUID(), claims)}`).send({}).expect(401);
      }
      await request.post("/api/v1/users/me").set("Authorization", `Bearer ${await fixture.token(randomUUID(), { scope: "openid" })}`).send({}).expect(403);
      const count = await database.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.accounts");
      assert.equal(count.rows[0]!.count, 2);
    });
    await t.test("database constraints reject conflicting bindings, duplicate account links and absent accounts", async () => {
      const issuer = fixture.config.auth0!.issuer;
      const insert = "INSERT INTO public.account_identities (issuer, subject, account_id) VALUES ($1, $2, $3)";
      await assert.rejects(database.db.query(insert, [issuer, subjectA, accountB]));
      await assert.rejects(database.db.query(insert, [issuer, randomUUID(), accountA]));
      await assert.rejects(database.db.query(insert, [issuer, randomUUID(), randomUUID()]));
    });

    await t.test("concurrent resumption is idempotent without orphan candidates; issuer is part of ownership", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({}).expect(200)));
      assert(results.every((response) => response.body.account.id === accountA && response.body.created === false));
      const counts = await database.db.query<{ accounts: number; bindings: number }>("SELECT (SELECT count(*)::integer FROM public.accounts) AS accounts, (SELECT count(*)::integer FROM public.account_identities) AS bindings");
      assert.deepEqual(counts.rows[0], { accounts: 2, bindings: 2 });
      const firstToken = await fixture.token(randomUUID());
      const first = await Promise.all(Array.from({ length: 6 }, () => request.post("/api/v1/users/me").set("Authorization", `Bearer ${firstToken}`).send({}).expect(200)));
      assert.equal(new Set(first.map((response) => response.body.account.id)).size, 1);
      assert.equal(first.filter((response) => response.body.created === true).length, 1);
      const afterFirst = await database.db.query<{ accounts: number; bindings: number }>("SELECT (SELECT count(*)::integer FROM public.accounts) AS accounts, (SELECT count(*)::integer FROM public.account_identities) AS bindings");
      assert.deepEqual(afterFirst.rows[0], { accounts: 3, bindings: 3 });
      const repository = module.get(AccountRepository);
      const otherIssuer = { issuer: `https://${randomUUID()}.auth0.com/`, subject: subjectA };
      await assert.rejects(repository.readOwn(otherIssuer));
      const another = await repository.createOrResume(otherIssuer);
      assert.notEqual(another.account.id, accountA);
    });

    await t.test("disabled accounts cannot be read or resumed, and failures leave no orphan accounts", async () => {
      await database.db.query("UPDATE public.accounts SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP WHERE id = $1", [accountA]);
      await request.get("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).expect(403);
      await request.post("/api/v1/users/me").set("Authorization", `Bearer ${tokenA}`).send({}).expect(403);
      const orphan = await database.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM public.accounts a LEFT JOIN public.account_identities i ON i.account_id = a.id WHERE i.account_id IS NULL");
      assert.equal(orphan.rows[0]!.count, 0);
      await request.get("/api/v1/users/me").set("Authorization", `Bearer ${tokenB}`).expect(200);
    });

    await t.test("tokens, issuer subjects and internal account IDs never reach operational logs", () => {
      const output = logs.join("");
      for (const value of [tokenA, tokenB, subjectA, subjectB, accountA, accountB]) assert.equal(output.includes(value), false);
    });
  } finally { await app.close(); await database.close(); }
});
