// In-memory rate limiting + a concurrency-bounded work queue. Fine for the
// single-machine deployment; swap for a shared store (Redis) when we scale out.

const hits = new Map<string, number[]>();

/** Sliding-window limiter: true if this key is under `max` hits in `windowMs`. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

// Periodically drop empty buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    if (!arr.some((t) => now - t < 3_600_000)) hits.delete(k);
  }
}, 600_000).unref?.();

/**
 * Runs CPU-heavy jobs (sandboxed matches) at most `concurrency` at a time, with
 * a bounded backlog so a flood is rejected instead of piling up and OOMing.
 */
export class WorkQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
  ) {}

  get full(): boolean {
    return this.waiting.length >= this.maxPending;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.waiting.shift()?.();
          });
      };
      if (this.running < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}
