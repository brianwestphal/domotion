---
id: "requirements/programmatic-debug-capture-bundles"
title: "Programmatic debug capture bundles"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2635"]
code: ["src/capture/debug-bundle.ts","src/capture/index.ts","src/index.ts","tests/capture-debug-api.e2e.test.ts"]
aliases: ["docs/238-programmatic-debug-capture-bundles.md","doc-238"]
---

# Programmatic debug capture bundles

Library consumers that already manage Playwright pages and browser contexts can
collect the same reproduction evidence as `domotion capture --debug` without
adopting the CLI's directory names or filesystem lifecycle.

## Capture and render

```ts
import {
  assembleCaptureDebugBundle,
  captureElementTreeWithDebug,
  elementTreeToSvg,
} from "domotion-svg";

const result = await captureElementTreeWithDebug(
  page,
  "body",
  { x: 0, y: 0, width: 1024, height: 768 },
);
const actualSvg = elementTreeToSvg(result.tree, 1024, 768);
const bundle = assembleCaptureDebugBundle(result.debug, actualSvg);
```

`captureElementTreeWithDebug()` returns the complete inline warning/state result
from `captureElementTreeWithWarnings()` plus:

- `debug.expectedPng`: PNG bytes from the same stable Chromium frame and clip
  used for capture;
- `debug.capturedTreeJson`: a pretty-printed inspection copy of the raw tree.

The API does not launch a browser, open a review UI, create a directory, write a
file, or close the caller's page/context. `assembleCaptureDebugBundle()` adds the
complete SVG produced by the caller and returns copied in-memory artifacts, so
the caller can send them to disk, object storage, an issue tracker, or another
transport under its own names.

## Caller-owned HAR lifecycle

Playwright requires HAR recording when a `BrowserContext` is created and does
not reliably flush the archive until that context is closed. A capture function
called against an existing `Page` therefore cannot add HAR recording
retroactively, and must not close a context it does not own.

Callers that need offline network replay configure their own context, close it
after capture, read their chosen HAR destination, and pass the bytes to the
assembler:

```ts
const context = await browser.newContext({
  recordHar: { path: callerHarPath, mode: "minimal" },
});
const page = await context.newPage();
// navigate, capture, and render here
await context.close(); // flushes callerHarPath

const bundle = assembleCaptureDebugBundle(result.debug, actualSvg, {
  captureHar: await fs.readFile(callerHarPath),
});
```

HAR is optional because static/local inputs and contexts that were not armed at
creation cannot supply one honestly. When present, the assembler accepts UTF-8
text or bytes and stores a byte copy as `captureHar`.

## Stability boundary

The stable contract is the semantic bundle fields and their media: PNG bytes,
raw-tree JSON text, complete SVG text, and optional HAR bytes. The raw captured
tree remains an inspection artifact rather than a separately versioned public
schema. Debug collection does not change capture routing, render mode, output
optimization, or browser ownership.
