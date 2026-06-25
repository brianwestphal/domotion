---
title: Scripting API
description: Use Domotion's primitives as a library when you outgrow the CLI.
---

When you outgrow the CLI — custom interaction loops, programmatic frame
composition, custom overlays — the same primitives are available as a library.
All are named exports of `domotion-svg` (ESM).

```ts
import { captureElementTree, elementTreeToSvg, launchChromium } from "domotion-svg";

const browser = await launchChromium();
const page = await browser.newPage();
await page.setContent(`<div style="padding:20px;color:white;background:#0d1117">Hello</div>`);

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 200 });
const svg = elementTreeToSvg(tree, 800, 200);

console.log(svg);
await browser.close();
```

## Key exports

- **`captureElementTree(page, selector, rect)`** — walk the DOM into a
  serializable tree.
- **`elementTreeToSvg(tree, w, h, opts?)`** — render the tree to a complete
  `<svg>` document.
- **`generateAnimatedSvg(config)`** — compose captured frames into one animated
  SVG.
- **`composeAnimatedLayers(layers, opts)`** — nest / layer animated SVGs (the
  `composite` engine).
- **`renderTemplateToSvg(template, params, { browser })`** — render a template.
- **`launchChromium()`** — browser lifecycle.
- **`optimizeSvg(svg)`** · **`wrapInDeviceChrome(...)`**.

For the multi-frame pipeline, the declarative entry point is
`composeAnimateConfig(browser, cfg)` after `validateAnimateConfig(json)`.

:::note
This page is a starting point. The canonical, always-current API surface lives in
the repo's `docs/` and is verified against the build; a later phase will sync it
here. For now, `domotion --help` and the source are authoritative.
:::
