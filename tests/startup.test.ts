import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("service and migration executables reject production configuration with redacted JSON logs", async () => {
  const sentinel = "fixture-secret-not-for-startup-logs";
  for (const [script, event] of [["../src/main.js", "startup_failed"], ["../scripts/migrate.js", "migration_failed"]]) {
    const result = await new Promise<{ exitCode: number | string | null | undefined; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, [resolve(__dirname, script!)], {
        env: { ...process.env, NODE_ENV: "production", DATABASE_URL: `postgresql://user:${sentinel}@remote.example/trueid` },
        timeout: 20_000,
        windowsHide: true,
      }, (error, stdout, stderr) => done({ exitCode: error?.code, stdout, stderr }));
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    const entry = JSON.parse(result.stderr.trim());
    assert.deepEqual(Object.keys(entry).sort(), ["event", "level", "time"]);
    assert.equal(entry.event, event);
    assert.equal(entry.level, "error");
    assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(result.stderr.includes(sentinel), false);
  }
});
