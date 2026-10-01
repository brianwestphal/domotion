# Browser ownership in tools and harnesses

Standalone TypeScript browser tools use `withBrowser` from `tools/lib/browser.ts`. Plain-Node `.mjs` and `.mts` probes use the equivalent `tools/lib/browser.mjs` entry point, so they run without a TypeScript loader. Both owners pass Chromium to an async callback and close it when the callback resolves or throws. A tool that also starts a server keeps the server in an outer `try/finally`, so the browser closes before the server.

```ts
await withBrowser(async (browser) => {
  const page = await browser.newPage();
  // Collect, compare, and write the tool's existing report here.
});
```

The helper accepts Playwright launch options as its second argument, including a pinned `executablePath`. A collector can supply a custom `launch` function in its third argument. It can also set `closeTimeoutMs` when its previous teardown contract used a specific deadline. Long-running probes that recycle Chromium use `openOwnedBrowser` for each generation and close the previous owner before launching another. Keep collector-specific context, CDP session, and server cleanup in the callback or outer scope as appropriate.

Harnesses that return a live browser use `openOwnedBrowser`. Its returned `close()` method is idempotent. `tests/harness-browsers.ts` uses one owner when capture and raster flags match and two owners when they differ. If the second launch fails, it closes the first browser before rethrowing. When both launches succeed, harness cleanup closes raster first, then capture, even if raster cleanup throws.

The helper does not change browser flags, the configured executable, collector output, baseline formats, or when reports are written. Individual E2E tests retain their own fixture and hook lifecycle. Both entries use idempotent, deadline-bounded cleanup; a failed probe still closes its browser.
