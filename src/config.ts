import type { LogLevel } from './logger.js';
import { WRITER_KINDS } from './db/log-writer.js';
import type { WriterKind } from './db/log-writer.js';

export interface DatabaseConfig {
  url: string;
  poolSize: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface IngestConfig {
  writer: WriterKind;
  flushIntervalMs: number;
  flushMaxBytes: number;
  queueMaxBytes: number;
  maxConcurrentFlushes: number;
}

export interface MaintenanceConfig {
  aheadDays: number;
  retentionDays: number;
  intervalMs: number;
}

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: LogLevel;
  maxBodyBytes: number;
  database: DatabaseConfig;
  ingest: IngestConfig;
  maintenance: MaintenanceConfig;
}

class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function oneOf<T extends string>(env: Env, key: string, fallback: T, allowed: readonly T[]): T {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    nodeEnv: oneOf(env, 'NODE_ENV', 'development', ['development', 'production', 'test'] as const),
    host: str(env, 'HOST', '0.0.0.0'),
    port: int(env, 'PORT', 8080, 1, 65535),
    logLevel: oneOf(env, 'LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error'] as const),
    // Ingest batches are far larger than Fastify's 1 MB default, which would reject them outright.
    maxBodyBytes: int(env, 'HTTP_MAX_BODY_BYTES', 4 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    database: {
      url: str(env, 'DATABASE_URL', 'postgres://logs:logs@localhost:5432/logs'),
      poolSize: int(env, 'DATABASE_POOL_SIZE', 8, 1, 64),
      connectionTimeoutMs: int(env, 'DATABASE_CONNECTION_TIMEOUT_MS', 10_000, 100, 120_000),
      statementTimeoutMs: int(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 30_000, 100, 600_000),
    },
    ingest: {
      writer: oneOf(env, 'INGEST_WRITER', 'binary', WRITER_KINDS),
      flushIntervalMs: int(env, 'INGEST_FLUSH_INTERVAL_MS', 50, 1, 5_000),
      flushMaxBytes: int(env, 'INGEST_FLUSH_MAX_BYTES', 8 * 1024 * 1024, 1024, 128 * 1024 * 1024),
      // Sized against the 256 MB container so a backlog sheds load instead of ending in an OOM.
      queueMaxBytes: int(env, 'INGEST_QUEUE_MAX_BYTES', 64 * 1024 * 1024, 1024, 192 * 1024 * 1024),
      maxConcurrentFlushes: int(env, 'INGEST_MAX_CONCURRENT_FLUSHES', 4, 1, 32),
    },
    maintenance: {
      // Lookahead margin so rows still land in a real partition if a cycle is missed.
      aheadDays: int(env, 'PARTITION_AHEAD_DAYS', 3, 1, 30),
      retentionDays: int(env, 'RETENTION_DAYS', 30, 1, 3650),
      intervalMs: int(env, 'MAINTENANCE_INTERVAL_MS', 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
    },
  };
}

export { ConfigError };
