const VERSION = 1;

// Ids are bigints carried as decimal strings, so the shape is checked rather than the value.
const DECIMAL_ID = /^\d{1,19}$/;

export interface Cursor {
  timestampMs: number;
  id: string;
}

// The cursor is opaque to callers but not authenticated: it encodes a position, never a
// permission, so a tampered one can only ever move the reader within results it already asked for.
export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({ v: VERSION, t: cursor.timestampMs, i: cursor.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { v, t, i } = parsed as { v?: unknown; t?: unknown; i?: unknown };
  if (v !== VERSION) return null;
  if (typeof t !== 'number' || !Number.isInteger(t)) return null;
  if (typeof i !== 'string' || !DECIMAL_ID.test(i)) return null;

  return { timestampMs: t, id: i };
}
