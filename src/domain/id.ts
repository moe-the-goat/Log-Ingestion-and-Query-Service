const SEQUENCE_BITS = 20;
const SEQUENCE_SPAN = 1 << SEQUENCE_BITS;
const MAX_SEQUENCE = SEQUENCE_SPAN - 1;

// The millisecond splits across the two words: its low 12 bits share the low word with the
// sequence, the rest becomes the high word.
const MS_SPLIT = 1 << 12;
const WORD_SPAN = 0x1_0000_0000n;

export interface LogId {
  hi: number;
  lo: number;
}

let lastMs = 0;
let sequence = 0;

// Ids carry the millisecond that produced them, so they rise with time and give (ts, id)
// pagination a stable tie-break without a nextval round-trip per row. They are kept as two
// 32-bit halves because a bigint is above what a JS number holds exactly, and allocating a
// BigInt per row is exactly the cost the copy path exists to avoid.
export function nextId(nowMs: number = Date.now()): LogId {
  if (nowMs > lastMs) {
    lastMs = nowMs;
    sequence = 0;
  } else if (sequence < MAX_SEQUENCE) {
    sequence += 1;
  } else {
    // Over a million ids inside one millisecond; borrow from the next one to stay unique.
    lastMs += 1;
    sequence = 0;
  }

  return {
    hi: Math.floor(lastMs / MS_SPLIT),
    lo: (lastMs % MS_SPLIT) * SEQUENCE_SPAN + sequence,
  };
}

export function idToString(id: LogId): string {
  return (BigInt(id.hi) * WORD_SPAN + BigInt(id.lo)).toString();
}
