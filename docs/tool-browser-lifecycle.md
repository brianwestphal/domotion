# Browser ownership in tools and harnesses

Standalone browser tools use `withBrowser` from `tools/lib/browser.ts`. It launches the project's configured Chromium, passes the browser to an async callback, and closes it when the callback resolves or throws. A tool that also starts a server keeps the server in an outer `try/finally`, so the browser closes before the server.

```ts
await withBrowser(async (browser) => {
  const page = await browser.newPage();
  // Collect, compare, and write the tool's existing report here.
});
```

The helper accepts Playwright launch options as its second argument. A collector that requires a pinned Chromium binary supplies a custom `launch` function in its third argument. It can also set `closeTimeoutMs` when its previous teardown contract used a specific deadline. Keep collector-specific context, CDP session, and server cleanup in the callback or outer scope as appropriate.

Harnesses that return a live browser use `openOwnedBrowser`. Its returned `close()` method is idempotent. `tests/harness-browsers.ts` uses one owner when capture and raster flags match and two owners when they differ. If the second launch fails, it closes the first browser before rethrowing. When both launches succeed, harness cleanup closes raster first, then capture, even if raster cleanup throws.

The helper does not change browser flags, the configured executable, collector output, baseline formats, or when reports are written. Individual E2E tests retain their own fixture and hook lifecycle. Legacy plain-Node `.mjs` probes need a JavaScript-compatible owner before they can adopt this helper; that migration is tracked in `DM-Z082AE`.
