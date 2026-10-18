// Local/CI probe: never accepts an arbitrary target URL, reads tokens or prints bodies.
import { setTimeout as delay } from "node:timers/promises";

async function probe(path: string, status: number, expected: string): Promise<void> {
  const rawPort = process.env.TRUEID_PORT ?? "4200";
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error();
  const response = await fetch(`http://127.0.0.1:${rawPort}/api/v1/${path}`, {
    signal: AbortSignal.timeout(2500), redirect: "error",
  });
  if (response.status !== status || !response.headers.get("x-request-id")) throw new Error();
  const body = await response.json() as { demo?: unknown; status?: unknown; error?: { code?: unknown } };
  if (body.demo !== true || (status === 200 ? body.status : body.error?.code) !== expected) throw new Error();
}

async function smoke(): Promise<void> {
  const livenessOnly = process.argv.slice(2).join(" ") === "--liveness";
  if (process.argv.length > 2 && !livenessOnly) throw new Error();
  for (let attempt = 0; attempt < (livenessOnly ? 1 : 20); attempt++) {
    try {
      await probe("health/live", 200, "alive");
      if (!livenessOnly) {
        await probe("health", 200, "ready");
        await probe("users/me", 401, "unauthenticated");
      }
      process.stdout.write("Runtime smoke check passed.\n");
      return;
    } catch {
      if (livenessOnly || attempt === 19) throw new Error();
      await delay(500);
    }
  }
}
void smoke().catch(() => {
  process.stderr.write("Runtime smoke check failed.\n");
  process.exitCode = 1;
});
