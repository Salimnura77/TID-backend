import { Pool } from "pg";
import type { RuntimeConfig } from "../config/runtime-config";
import type { StructuredLogger } from "../logging/structured-logger";

export function createPool(config: RuntimeConfig, logger: StructuredLogger): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    options: "-c timezone=UTC -c search_path=public -c statement_timeout=5000 -c lock_timeout=5000",
    application_name: "trueid_local_stage1",
  });
  // An idle connection error must not crash the process or print connection details.
  pool.on("error", () => logger.emit("database_unavailable"));
  return pool;
}
