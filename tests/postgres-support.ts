import { randomUUID } from "node:crypto";
import { readConfig } from "../src/config/runtime-config";

// Separate from DATABASE_URL: this suite must never migrate a developer's pilot DB.
// The administrator connection is read-only except CREATE/DROP of our random database.
export function postgresTestSettings(env: NodeJS.ProcessEnv) {
  const message = "Set TRUEID_TEST_DATABASE_URL to a dedicated loopback trueid_ci database.";
  try {
    const config = readConfig({ NODE_ENV: "test", DATABASE_URL: env.TRUEID_TEST_DATABASE_URL });
    const url = new URL(config.databaseUrl);
    if (url.pathname !== "/trueid_ci") throw new Error();
    const databaseName = `trueid_ci_${randomUUID().replaceAll("-", "")}`;
    url.pathname = `/${databaseName}`;
    return { admin: config, databaseName, isolated: readConfig({ NODE_ENV: "test", DATABASE_URL: url.href }) };
  } catch { throw new Error(message); }
}
