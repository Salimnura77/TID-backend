import { readConfig } from "../src/config/runtime-config";
import { applyMigrations, loadMigrations } from "../src/database/migrations";
import { createPool } from "../src/database/pool";
import { executorFor } from "../src/database/sql-executor";
import { StructuredLogger } from "../src/logging/structured-logger";

async function migrate(): Promise<void> {
  const config = readConfig();
  const migrations = await loadMigrations();
  const logger = new StructuredLogger(config.logLevel);
  const pool = createPool(config, logger);
  try {
    const client = await pool.connect();
    let failed = true;
    try {
      const count = await applyMigrations(executorFor(client), migrations);
      failed = false;
      logger.emit("migrations_applied", { count });
    } finally { client.release(failed); }
  } finally { await pool.end(); }
}

void migrate().catch(() => {
  new StructuredLogger().emit("migration_failed");
  process.exitCode = 1;
});
