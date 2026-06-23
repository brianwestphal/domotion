# domotion-template-quote-card

A worked example of a **third-party Domotion template** — copy this directory as
the starting point for your own. It is a *generator* template that animates a
pull-quote card rising + fading into place.

The full walkthrough is **[`docs/74-template-authoring.md`](../../docs/74-template-authoring.md)**;
this README is the quick reference.

## The shape

A template package is an ordinary npm package named **`domotion-template-<name>`**
that exports a `Template` (default export, or a named `template` export):

```ts
import { z } from "zod";
import type { Template, TemplateRenderContext, TemplateOutput } from "domotion-svg";

export const myTemplate: Template<MyParams> = {
  name: "quote-card",            // → `domotion template quote-card`
  description: "…",              // shown by `domotion template list`
  paramsSchema: /* a zod schema */,
  async render(params, ctx): Promise<TemplateOutput> { /* … */ },
};
export default myTemplate;
```

`domotion-svg` is a **peer dependency** used only for the types — the render
context (`browser`, `workDir`, `log`, `runAnimateConfig`, `captureToSvg`) is
supplied by the host at runtime.

## Build & publish

```sh
npm install
npm run build            # tsc → dist/
npm publish              # name MUST be domotion-template-<name>
```

## Use it (as a consumer)

```sh
npm install -g domotion-svg domotion-template-quote-card
domotion template quote-card --quote "Ship it." --author "Ada" -o quote.svg
```

`domotion template` resolves the name to the `domotion-template-quote-card`
package automatically — no registration, no config. It also composes into an
`animate` config as a `template` frame (see `docs/73-template-frames.md`).

## Test it

Use the public `renderTemplateToSvg` API — no need to drive the CLI:

```ts
import { describe, it, expect } from "vitest";
import { renderTemplateToSvg } from "domotion-svg";
import { quoteCardTemplate, buildQuoteCardHtml } from "./index.js";

describe("quote-card", () => {
  // Pure builders need no browser.
  it("escapes the quote text", () => {
    expect(buildQuoteCardHtml({ quote: "<b>", accent: "#000", color: "#fff", width: 100, height: 100, holdMs: 1000 }))
      .toContain("&lt;b&gt;");
  });

  // The full render needs Chromium (Playwright).
  it("renders a self-contained animated SVG", async () => {
    const out = await renderTemplateToSvg(quoteCardTemplate, { quote: "Ship it.", author: "Ada" });
    expect(out.svg).toContain("<svg");
    expect(out.svg).toMatch(/@keyframes/);     // the rise + fade reveal
    expect(out.durationMs).toBe(2600);
  });
});
```
