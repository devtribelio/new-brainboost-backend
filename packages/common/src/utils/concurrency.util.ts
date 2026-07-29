/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Fan-out jobs (nightly digest push, bulk syncs) must not open one connection
 * per row: a few thousand members would otherwise hit the DB pool and FCM at
 * once. Workers pull from a shared cursor, so a slow item doesn't stall a whole
 * batch the way fixed chunking does.
 *
 * `fn` is expected to handle its own errors — a throw propagates and aborts the
 * remaining work.
 */
export async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  if (limit <= 1) {
    for (let i = 0; i < items.length; i += 1) await fn(items[i], i);
    return;
  }
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
