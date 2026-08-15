import { describe, expect, it } from 'vitest';
import { idToString, nextId } from '../../src/domain/id.js';

describe('nextId', () => {
  it('never repeats an id within the same millisecond', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      ids.add(idToString(nextId(1_753_021_921_123)));
    }

    expect(ids.size).toBe(10_000);
  });

  it('increases over time', () => {
    const earlier = BigInt(idToString(nextId(1_753_021_921_123)));
    const later = BigInt(idToString(nextId(1_753_021_921_124)));

    expect(later).toBeGreaterThan(earlier);
  });

  it('keeps both halves inside their 32-bit words', () => {
    for (let i = 0; i < 5_000; i += 1) {
      const id = nextId(1_753_021_921_500);
      expect(id.hi).toBeGreaterThanOrEqual(0);
      expect(id.hi).toBeLessThanOrEqual(0x7fff_ffff);
      expect(id.lo).toBeGreaterThanOrEqual(0);
      expect(id.lo).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  it('stays inside the signed 64-bit range', () => {
    const id = BigInt(idToString(nextId(Date.now())));

    expect(id).toBeGreaterThan(0n);
    expect(id).toBeLessThan(2n ** 63n - 1n);
  });

  it('recovers the generating millisecond from the id', () => {
    // Ahead of every millisecond used above, so the sequence restarts at zero.
    const milliseconds = Date.now() + 60_000;
    const id = BigInt(idToString(nextId(milliseconds)));

    expect(id >> 20n).toBe(BigInt(milliseconds));
  });

  it('composes the halves the same way postgres reads them', () => {
    const id = nextId(Date.now() + 120_000);

    expect(idToString(id)).toBe((BigInt(id.hi) * 4_294_967_296n + BigInt(id.lo)).toString());
  });
});
