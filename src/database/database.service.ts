import { Inject, Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import { APP_CONFIG } from "../config/runtime-config";
import type { RuntimeConfig } from "../config/runtime-config";
import { assertSchemaCurrent, loadMigrations } from "./migrations";
import type { Migration } from "./migrations";
import { createPool } from "./pool";
import { executorFor } from "./sql-executor";
import type { SqlExecutor } from "./sql-executor";
import { StructuredLogger } from "../logging/structured-logger";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private migrations: readonly Migration[] = [];

  constructor(@Inject(APP_CONFIG) config: RuntimeConfig, @Inject(StructuredLogger) logger: StructuredLogger) {
    this.pool = createPool(config, logger);
  }

  async onModuleInit(): Promise<void> { this.migrations = await loadMigrations(); }

  async assertReady(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await assertSchemaCurrent(executorFor(client), this.migrations);
    } finally {
      client.release();
    }
  }

  async withClient<T>(work: (client: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { return await work(executorFor(client)); }
    finally { client.release(); }
  }

  async transaction<T>(work: (client: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      const result = await work(executorFor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }

  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}
