/** Tracks completed/in-flight shard prefetches. A failed fetch is retriable. */
export function createReviewPrefetchState() {
  const started = new Set<string>();
  return {
    begin(key: string): boolean {
      if (started.has(key)) return false;
      started.add(key);
      return true;
    },
    failed(key: string): void {
      started.delete(key);
    },
    has(key: string): boolean {
      return started.has(key);
    },
  };
}
