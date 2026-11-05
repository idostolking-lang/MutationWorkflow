/**
 * Counting semaphore. Used to cap concurrent model calls (the user's "use up to 3 agents at a
 * time") and concurrent workflow executions.
 */
export class Semaphore {
  private readonly waiters: Array<() => void> = [];
  private available: number;

  constructor(public readonly size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`Semaphore size must be a positive integer, got ${size}`);
    }
    this.available = size;
  }

  /** Number of permits currently free. */
  get free(): number {
    return this.available;
  }

  /** Acquire a permit; the returned function releases it exactly once. */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.available += 1;
      }
    };
  }

  /** Run `fn` while holding a permit. */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const semaphore = new Semaphore(Math.max(1, Math.min(limit, items.length || 1)));
  return Promise.all(items.map((item, index) => semaphore.use(() => fn(item, index))));
}
