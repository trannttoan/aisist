// Writes each result by index so the output order matches the input order
// regardless of which request finishes first. Once one call fails the other
// workers stop taking new items, since the whole result is discarded.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;

        if (failed || index >= items.length) {
          return;
        }

        try {
          results[index] = await fn(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );

  await Promise.all(workers);

  return results;
}
