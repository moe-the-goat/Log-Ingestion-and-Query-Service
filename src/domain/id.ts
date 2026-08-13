const SEQUENCE_BITS = 20;
const SEQUENCE_SPAN = 1 << SEQUENCE_BITS;
const MAX_SEQUENCE = SEQUENCE_SPAN - 1;
const SEQUENCE_SPAN_BIG = BigInt(SEQUENCE_SPAN);

let lastMs = 0;
let sequence = 0;

// Ids carry the millisecond that produced them, so they rise with time and give (ts, id)
// pagination a stable tie-break without a nextval round-trip per row.
export function nextId(nowMs: number = Date.now()): string {
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

  return (BigInt(lastMs) * SEQUENCE_SPAN_BIG + BigInt(sequence)).toString();
}
