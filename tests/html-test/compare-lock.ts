/** One browser comparison page shared across concurrent fixture workers. */
export function createCompareLock<TPage>() {
  let page: TPage | null = null;
  let tail: Promise<void> = Promise.resolve();
  return {
    setPage(next: TPage | null): void {
      page = next;
    },
    async withCompareLock<T>(fn: (page: TPage) => Promise<T>): Promise<T> {
      const currentPage = page;
      if (currentPage == null) throw new Error("withCompareLock called before sharedComparePage was initialized");
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(currentPage);
      } finally {
        release();
      }
    },
  };
}
