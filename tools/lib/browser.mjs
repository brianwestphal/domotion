import { chromium } from "@playwright/test";

/** Own a Playwright browser from a plain-Node tool. Close is idempotent. */
export async function openOwnedBrowser(options, ownership = {}) {
  const browser = await (
    ownership.launch ?? ((launchOptions) => chromium.launch({ headless: true, ...launchOptions }))
  )(options);
  let closed = false;
  return {
    browser,
    async close() {
      if (closed) return;
      closed = true;
      let timer;
      const timeoutMs = ownership.closeTimeoutMs ?? 6_000;
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => browser.close())
            .catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function withBrowser(run, options, ownership = {}) {
  const owner = await openOwnedBrowser(options, ownership);
  try {
    return await run(owner.browser);
  } finally {
    await owner.close();
  }
}
