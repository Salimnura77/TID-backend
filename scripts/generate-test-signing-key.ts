import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main(): Promise<void> {
  // This utility cannot generate keys from development or production settings.
  if (process.env.NODE_ENV !== "test" || process.env.TRUEID_CREDENTIAL_SIGNING_MODE !== "test") throw new Error("Dedicated Test configuration is required.");
  const directory = resolve("test-keys");
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)).toLowerCase() !== resolve(await realpath("."), "test-keys").toLowerCase()) throw new Error("Invalid Test key directory.");
  const keyId = `test-${randomUUID()}`;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await writeFile(resolve(directory, `${keyId}.pem`), privateKey, { flag: "wx", mode: 0o600 });
  // Public identifier only, never key bytes. Dedicated files are gitignored.
  process.stdout.write(JSON.stringify({ environment: "test", keyId }) + "\n");
}
void main().catch(() => { process.stderr.write('{"event":"test_key_generation_failed"}\n'); process.exitCode = 1; });
