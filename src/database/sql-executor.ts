import type { PoolClient } from "pg";

export interface SqlRow { [column: string]: unknown }
export interface SqlExecutor {
  query<Row extends SqlRow = SqlRow>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export function executorFor(client: PoolClient): SqlExecutor {
  return {
    async query<Row extends SqlRow>(sql: string, values?: unknown[]) {
      return client.query<Row>(sql, values);
    },
  };
}
