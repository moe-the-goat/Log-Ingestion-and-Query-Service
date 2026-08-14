// Date.parse accepts things like "March 5 2020", so the shape is checked first. The offset is
// optional and a missing one is read as UTC, which keeps otherwise valid input out of the
// rejected list.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/;
const HAS_OFFSET = /([Zz]|[+-]\d{2}:?\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function parseTimestampMs(value: string): number | null {
  if (!ISO_8601.test(value)) return null;

  // Date.parse checks the day is 1-31 but not against the month, so it reads 2026-02-30 as
  // 2026-03-02 and would silently shift the timestamp by two days.
  const day = Number(value.slice(8, 10));
  if (day > daysInMonth(Number(value.slice(0, 4)), Number(value.slice(5, 7)))) return null;

  const milliseconds = Date.parse(HAS_OFFSET.test(value) ? value : `${value}Z`);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}
