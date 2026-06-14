// Bounded-concurrency map (pure, no dependency). Runs `fn` over `items` with at most `limit`
// concurrent calls; results preserve input order.

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!, i);
    }
  };

  // Defend against a non-finite / non-positive limit (e.g. a NaN from a bad --concurrency arg):
  // fall back to sequential rather than spawning zero workers and silently dropping items.
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const workerCount = Math.min(safeLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
