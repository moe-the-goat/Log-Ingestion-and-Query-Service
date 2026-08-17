import pg from 'pg';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../config.js';

// Every response re-serialises timestamps anyway, so parsing them into Date is pure overhead.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (value) => value);

export function createPool(config: DatabaseConfig): Pool {
  return new pg.Pool({
    connectionString: config.url,
    max: config.poolSize,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: 'log-service',
  });
}
