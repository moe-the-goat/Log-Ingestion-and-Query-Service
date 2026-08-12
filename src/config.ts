import type { LogLevel } from './logger.js';

export interface DatabaseConfig {
  url: string;
  poolSize: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: LogLevel;
  database: DatabaseConfig;
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
    database: {
      url: str(env, 'DATABASE_URL', 'postgres://logs:logs@localhost:5432/logs'),
      poolSize: int(env, 'DATABASE_POOL_SIZE', 8, 1, 64),
      connectionTimeoutMs: int(env, 'DATABASE_CONNECTION_TIMEOUT_MS', 10_000, 100, 120_000),
      statementTimeoutMs: int(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 30_000, 100, 600_000),
    },
  };
}

export { ConfigError };
