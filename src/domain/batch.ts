import { validateEntry } from './validate.js';
import type { LogRecord } from './log.js';

export interface Rejection {
  index: number;
  reason: string;
}

export interface IngestBatch {
  records: LogRecord[];
  rejected: Rejection[];
}

export type BatchResult = { ok: true; batch: IngestBatch } | { ok: false; error: string };

// A single bad entry must not sink the batch, so entry failures are collected by index while
// only a broken envelope rejects the whole request.
export function parseIngestBatch(body: Buffer, nowMs: number = Date.now()): BatchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const logs = (parsed as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) return { ok: false, error: 'logs must be an array' };
  if (logs.length === 0) return { ok: false, error: 'logs must not be empty' };

  const records: LogRecord[] = [];
  const rejected: Rejection[] = [];

  for (let index = 0; index < logs.length; index += 1) {
    const result = validateEntry(logs[index], nowMs);
    if (result.ok) {
      records.push(result.record);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  }

  return { ok: true, batch: { records, rejected } };
}
