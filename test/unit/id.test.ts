import { describe, expect, it } from 'vitest';
import { nextId } from '../../src/domain/id.js';

describe('nextId', () => {
  it('never repeats an id within the same millisecond', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      ids.add(nextId(1_753_021_921_123));
    }

    expect(ids.size).toBe(10_000);
  });

  it('increases over time', () => {
    const earlier = BigInt(nextId(1_753_021_921_123));
    const later = BigInt(nextId(1_753_021_921_124));

    expect(later).toBeGreaterThan(earlier);
  });

  it('stays inside the signed 64-bit range', () => {
    const id = BigInt(nextId(Date.now()));

    expect(id).toBeGreaterThan(0n);
    expect(id).toBeLessThan(2n ** 63n - 1n);
  });

  it('recovers the generating millisecond from the id', () => {
    // Ahead of every millisecond used above, so the sequence restarts at zero.
    const milliseconds = Date.now() + 60_000;
    const id = BigInt(nextId(milliseconds));

    expect(id >> 20n).toBe(BigInt(milliseconds));
  });
});
