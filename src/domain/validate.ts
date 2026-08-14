import { LOG_LEVELS } from './log.js';
import type { Attributes, LogLevel, LogRecord } from './log.js';
import { parseTimestampMs } from './time.js';

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);

const MAX_PREVIEW_LENGTH = 64;

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ValidationResult = { ok: true; record: LogRecord } | { ok: false; reason: string };

// Rejection reasons are echoed back to the caller, so untrusted text is capped.
function preview(value: unknown): string {
  if (typeof value !== 'string') return typeof value;
  return value.length > MAX_PREVIEW_LENGTH ? `${value.slice(0, MAX_PREVIEW_LENGTH)}...` : value;
}

function checkTimestamp(value: unknown, nowMs: number): Checked<number> {
  if (value === undefined || value === null) return { ok: false, reason: 'timestamp is required' };
  if (typeof value !== 'string') return { ok: false, reason: 'timestamp must be a string' };

  const milliseconds = parseTimestampMs(value);
  if (milliseconds === null) {
    return { ok: false, reason: `invalid timestamp: '${preview(value)}'` };
  }
  if (milliseconds > nowMs + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'timestamp is more than 5 minutes in the future' };
  }

  return { ok: true, value: milliseconds };
}

function checkLevel(value: unknown): Checked<LogLevel> {
  if (value === undefined || value === null) return { ok: false, reason: 'level is required' };
  if (typeof value !== 'string') return { ok: false, reason: 'level must be a string' };
  if (!LEVELS.has(value)) return { ok: false, reason: `invalid level: '${preview(value)}'` };
  return { ok: true, value: value as LogLevel };
}

function checkText(value: unknown, field: string): Checked<string> {
  if (value === undefined || value === null) return { ok: false, reason: `${field} is required` };
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: `${field} must be a non-empty string` };
  }
  return { ok: true, value };
}

function checkAttributes(value: unknown): Checked<Attributes> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'attributes must be an object' };
  }

  const attributes: Attributes = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'boolean') {
      attributes[key] = item;
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      attributes[key] = item;
    } else {
      return { ok: false, reason: `attributes.${key} must be a string, number or boolean` };
    }
  }

  return { ok: true, value: attributes };
}

export function validateEntry(input: unknown, nowMs: number = Date.now()): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'entry must be an object' };
  }

  const entry = input as Record<string, unknown>;

  const timestamp = checkTimestamp(entry.timestamp, nowMs);
  if (!timestamp.ok) return timestamp;

  const level = checkLevel(entry.level);
  if (!level.ok) return level;

  const service = checkText(entry.service, 'service');
  if (!service.ok) return service;

  const message = checkText(entry.message, 'message');
  if (!message.ok) return message;

  const attributes = checkAttributes(entry.attributes);
  if (!attributes.ok) return attributes;

  return {
    ok: true,
    record: {
      timestampMs: timestamp.value,
      level: level.value,
      service: service.value,
      message: message.value,
      attributes: attributes.value,
    },
  };
}
