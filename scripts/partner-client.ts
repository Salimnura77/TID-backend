import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readConfig } from "../src/config/runtime-config";
import { assertSchemaCurrent, loadMigrations } from "../src/database/migrations";
import { createPool } from "../src/database/pool";
import { executorFor } from "../src/database/sql-executor";
import { StructuredLogger } from "../src/logging/structured-logger";
import { disablePartner, listPartnerCredentials, provisionPartner, revokePartnerCredential, rotatePartnerCredential } from "../src/partners/provision-partner";

async function main(): Promise<void> {
  const config = readConfig(); // Production/remote DB remain rejected.
  const [action, value, credentialId, extra] = process.argv.slice(2);
  const keyAction = action === "rotate" || action === "revoke-key";
  if (extra || !value || !["register", "disable", "rotate", "revoke-key", "keys"].includes(action ?? "") ||
    (keyAction ? !credentialId : credentialId !== undefined)) throw new Error("Invalid command.");
  const pool = createPool(config, new StructuredLogger(config.logLevel));
  try {
    const client = await pool.connect();
    let failed = true;
    try {
      const executor = executorFor(client);
      await assertSchemaCurrent(executor, await loadMigrations());
      await client.query("BEGIN");
      if (action === "register" || action === "rotate") {
        const directory = resolve("partner-keys");
        await mkdir(directory, { recursive: true });
        if ((await realpath(directory)).toLowerCase() !== resolve(await realpath("."), "partner-keys").toLowerCase()) throw new Error("Invalid partner key directory.");
        const partner = action === "register" ? await provisionPartner(executor, value)
          : await rotatePartnerCredential(executor, value, credentialId!);
        // Local provisioning artifact only. Never put the key in console output,
        // mobile code, app logs or source control. Windows ACLs need local review.
        await writeFile(resolve(directory, `${partner.id}.${partner.credentialId}.json`), JSON.stringify(partner) + "\n", { flag: "wx", mode: 0o600 });
        await client.query("COMMIT");
        process.stdout.write(JSON.stringify({ event: action === "register" ? "partner_registered" : "partner_key_rotated",
          partnerId: partner.id, credentialId: partner.credentialId }) + "\n");
      } else if (action === "keys") {
        const credentials = await listPartnerCredentials(executor, value);
        await client.query("COMMIT");
        process.stdout.write(JSON.stringify({ partnerId: value, credentials }) + "\n");
      } else {
        if (action === "revoke-key") await revokePartnerCredential(executor, value, credentialId!);
        else await disablePartner(executor, value);
        await client.query("COMMIT");
        process.stdout.write(JSON.stringify({ event: action === "revoke-key" ? "partner_key_revoked" : "partner_disabled" }) + "\n");
      }
      failed = false;
    } finally {
      if (failed) { try { await client.query("ROLLBACK"); } catch { /* Discard below. */ } }
      client.release(failed);
    }
  } finally { await pool.end(); }
}
void main().catch(() => { process.stderr.write('{"event":"partner_setup_failed"}\n'); process.exitCode = 1; });
