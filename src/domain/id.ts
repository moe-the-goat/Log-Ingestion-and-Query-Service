const SEQUENCE_BITS = 20;
const SEQUENCE_SPAN = 1 << SEQUENCE_BITS;
const MAX_SEQUENCE = SEQUENCE_SPAN - 1;

// The millisecond's low 12 bits share the low word with the sequence; the rest is the high word.
const MS_SPLIT = 1 << 12;
const WORD_SPAN = 0x1_0000_0000n;

export interface LogId {
  hi: number;
  lo: number;
}

let lastMs = 0;
let sequence = 0;

// Ids embed their millisecond so (ts, id) pagination has a stable tie-break with no nextval.
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
