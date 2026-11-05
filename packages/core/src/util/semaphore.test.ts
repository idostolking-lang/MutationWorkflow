import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('limits concurrency and releases permits exactly once', async () => {
    const semaphore = new Semaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    expect(semaphore.free).toBe(0);
    let third = false;
    const pending = semaphore.acquire().then((release) => {
      third = true;
      release();
    });
    await Promise.resolve();
    expect(third).toBe(false);
    first();
    first();
    await pending;
    expect(third).toBe(true);
    second();
    expect(semaphore.free).toBe(2);
  });

  it('rejects a waiter that times out and leaves the queue clean', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    await expect(semaphore.acquire(20)).rejects.toThrow(/Timed out/);
    release();
    expect(semaphore.free).toBe(1);
    const again = await semaphore.acquire(20);
    again();
  });

  it('maps with bounded concurrency in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
