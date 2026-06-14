import { describe, expect, it } from 'vitest';
import { mapLimit } from '../concurrency.js';

describe('mapLimit', () => {
  it('processes all items, preserving input order in the results', async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, async (x) => x * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit (AC-11)', async () => {
    let active = 0;
    let maxActive = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((res) => setTimeout(res, 5));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('handles a limit larger than the item count', async () => {
    expect(await mapLimit([1, 2], 10, async (x) => x + 1)).toEqual([2, 3]);
  });

  it('treats a non-finite limit as sequential (no crash, no dropped items — review fix)', async () => {
    expect(await mapLimit([1, 2, 3], Number.NaN, async (x) => x * 2)).toEqual([2, 4, 6]);
  });
});
