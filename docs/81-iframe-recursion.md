# 81 — `<iframe>` recursion into native SVG

## Summary

An `<iframe>` used to be a **replaced element**: Domotion screenshotted its
content box and emitted one flat `<image>` (see
[reference/raster-image-fallback-cases.md](reference/raster-image-fallback-cases.md)
§E4). That raster was blurry at scale, had no selectable text, and bloated the
output.

Domotion now **recurses an accessible iframe's document into native SVG** —
crisp `<path>` glyphs, real `<rect>`/gradient fills, selectable text, scalable
to any zoom — by walking the inner document with the **same** capture logic and
splicing the result in as the iframe node's child, transformed into the parent
page's coordinate space.

Two phases:

- **Phase 1 — same-origin recursion (Shipped, default-on, no browser flags).**
  When the iframe's `contentDocument` is accessible (same-origin), recurse it.
  This covers `srcdoc`, `about:blank`/JS-populated frames, and any same-site
  embed (email previews, sandboxed same-origin widgets, design-tool canvases).
- **Phase 2 — opt-in cross-origin recursion (Shipped).** Cross-origin
  `contentDocument` is `null` under the Same-Origin Policy. The
  `--cross-origin-frames` flag launches Chromium with web security disabled so
  cross-origin frames become readable, gated by a host allowlist. See
  [Phase 2 — cross-origin](#phase-2--cross-origin-recursion-shipped) below.
  Without the flag (default), cross-origin frames stay the raster `<image>`
  fallback.

## What still rasters

Recursion only replaces the raster when there is a DOM to walk. These stay
raster `<image>` snapshots:

- **Cross-origin frames** (until Phase 2 ships, and then only when allowlisted).
- **`<canvas>` / `<video>` / WebGL frames** and other pixel surfaces — there is
  no DOM to recurse.
- **Login / consent-gated frames** — the page renders its gated state; recursion
  faithfully captures whatever is actually painted, but no flag conjures content
  the embedder can't see.
- **A frame that hasn't loaded a document** (`contentDocument.body == null`).

A `<iframe>` warning is still emitted **only** for frames that fall back to a
raster; recursed frames are silent.

## Phase 1 — same-origin recursion

### Accessibility gate

`_iframeIsRecursable(el)` (in `src/capture/script/index.ts`, page context)
returns the inner `Document` or `null`:

1. The element must be an `<iframe>`.
2. `el.contentDocument` must be readable and have a `body` + `documentElement`.
   Cross-origin access throws or yields `null` → not recursable.
3. `_frameIsCrossOrigin(el)` must be false. Under the SOP a readable
   `contentDocument` is already same-origin, so this is a defensive guard: if a
   frame's document became readable **only** because web security was disabled
   (the Phase 2 path), Phase 1 refuses to recurse it until the allowlist gate is
   wired. `srcdoc` / `about:blank` report origin `"null"` (or inherit the
   embedder) and are treated as same-origin.

### Coordinate placement — the `vp`-shift trick

The inner document's element rects come from `getBoundingClientRect()` **relative
to the iframe's own viewport** (origin at the iframe content box's top-left,
already reflecting the iframe's inner scroll). To place them in the parent page's
captured coordinate space we must add the iframe content box's top-left in the
top document's client coordinates:

```
dx = iframeRect.left + borderLeft + paddingLeft
dy = iframeRect.top  + borderTop  + paddingTop
```

Rather than offsetting every coordinate field of the captured subtree after the
fact (fragile — miss one field and that paint lands in the wrong place), the
capture script **temporarily shifts the shared `vp` origin** for the duration of
the inner walk:

```js
vp.x = savedX - dx;  vp.y = savedY - dy;
node = capture(innerDoc.documentElement);
vp.x = savedX;       vp.y = savedY;       // restored in a finally
```

Every capture helper reads `vp.x`/`vp.y` **live** (they all close over the same
`vp` object), and every captured coordinate is computed as `clientCoord - vp.x`.
With `vp.x` shifted by `-dx`, an inner element at inner-client `ix` is emitted at
`ix - (savedX - dx) = (ix + dx) - savedX` — exactly its position in the parent's
captured space. As a bonus, the **viewport cull** then tests each inner element's
*true* painted position against the real capture region, so inner content that
maps off-screen is culled correctly.

This composes for **nested** same-origin iframes: each inner rect is relative to
its own frame's viewport, so successive `vp` shifts accumulate the content-box
origins down the chain. (Verified by construction; the math is in the
`_captureIframeRecursion` header comment.)

### Clipping

The recursed subtree is spliced as the iframe node's single child (the inner
`<html>` node), and the iframe node is marked `overflow: hidden` on both axes so
the renderer's existing overflow-clip wraps the inner content in
`<g clip-path="url(#ov…)">`, clipping it to the iframe's content box. The iframe
element's own background and border still paint (it's a normal box that now has
children), matching how a bordered iframe looks in Chrome.

### Code map

- `src/capture/script/index.ts` — `_frameIsCrossOrigin`, `_iframeIsRecursable`,
  `_captureIframeRecursion`; wired into `captureInner` just before the
  replaced-element routing. Sets `_captured.children`, `_captured._iframeRecursed`,
  and `overflowX/Y = 'hidden'`. The `_iframeRecursed` marker is deleted after the
  replaced-element handler runs (it only exists to gate that handler).
- `src/capture/script/walker/replaced-elements.ts` — skips the raster-snapshot
  path for an iframe when `captured._iframeRecursed === true`.
- Renderer: **no changes** — a node with `children` and no `replacedSnapshot`
  renders its children normally, and the overflow clip already exists.

### Known Phase-1 limitations

These are acceptable for v1 (common embeds are unaffected) and tracked as a
follow-up. They stem from the inner walk reusing the **outer** document's
pre-pass state (which is keyed on outer-document elements) rather than running
fresh pre-passes against the inner document:

- **CSS counters** (`counter()` / `counters()`) inside iframe content don't
  resolve — the counter pre-walk runs on the outer root only.
- **`@counter-style`** rules defined *inside* the iframe's own stylesheets aren't
  collected.
- **`position: fixed` / `sticky`** descendants and **`transform`-influenced**
  off-screen descendants inside the iframe don't get the outer walk's
  viewport-cull exemptions, so an off-screen-but-should-paint inner element can
  be dropped.
- **`transform: scale()` / `zoom`** ancestors *inside* the iframe don't fold into
  the cumulative-scale map, so inner text metrics under an inner scale aren't
  pre-scaled.
- **Inner mask / clip-path / filter `<defs>`** referenced from iframe content
  aren't hoisted to the output `<svg>`.

## Phase 2 — cross-origin recursion (Shipped)

Cross-origin `contentDocument` is `null` from page context. Launching Chromium
with `--disable-web-security` (and `--disable-features=IsolateOrigins,site-per-process`
to co-locate frames in one renderer process — needed on some builds, harmless on
the rest) makes it readable from the in-page capture script. The Same-Origin
Policy gates only cross-document **script access** — not layout, computed styles,
glyph metrics, or paint — so **fidelity is unaffected**: once the document is
readable, the Phase 1 recursion + `vp`-shift geometry place it correctly with no
further work.

### Flag: `--cross-origin-frames <value>`

- `*` → recurse into **all** cross-origin frames.
- A comma-separated **host allowlist**, port optional per entry, e.g.
  `--cross-origin-frames "youtube.com,maps.google.com:443,localhost:3000"`. Only
  frames whose origin matches an entry are recursed; the rest stay raster.
- **Omitted (default)** → no cross-origin recursion (Phase 1 same-origin
  recursion still happens). An empty value is rejected by the CLI.

A config-object form mirrors the CLI for the scripting API: the `CaptureOptions`
field `captureCrossOriginFrames?: string` (consumed by `DemoRecorder`), and the
`captureElementTree(page, sel, vp, { crossOriginFrames })` opt for the low-level
capture entry point.

### Matching semantics

Implemented as two pure functions in `src/capture/script/cross-origin.ts`
(`parseCrossOriginAllowlist` + `frameHostAllowed`) — bundled into the page-context
capture script **and** unit-tested node-side
(`src/capture/script/cross-origin.test.ts`):

- Each cross-origin frame's **current origin** (read from
  `contentWindow.location`, falling back to the `src` attribute) is matched
  against the allowlist.
- An entry with `:port` requires an exact **host + port** match; default ports are
  normalized (`http`→80, `https`→443) so `maps.google.com:443` matches
  `https://maps.google.com/`. Without a port, the host matches on **any port**.
- `*` matches everything.
- **Subdomain handling: exact host.** `example.com` does **not** match
  `www.example.com`. (A future `*.example.com` wildcard entry may be added; until
  then, list each host explicitly.)

### Plumbing

`--disable-web-security` is a **browser-launch** flag (all-or-nothing, not
per-frame). When the allowlist is non-empty (or `*`), Chromium is launched with
it via `crossOriginFramesLaunchArgs(value)` (returns the args array, or `[]` when
no cross-origin recursion is requested). The allowlist then governs which frames
are actually recursed, so even with web security off only allowlisted hosts get
processed — **limiting blast radius** (verified: a non-allowlisted frame stays a
raster even when its document is readable). Wiring:

- `src/cli/capture.ts` — parses `--cross-origin-frames`, validates it, prints the
  security warning, launches with the args, threads the value to `captureElementTree`.
- `src/capture/index.ts` — `crossOriginFramesLaunchArgs`, the `CaptureOptions`
  field + `DemoRecorder` wiring, and `cof` serialized into the capture-script args.
- `src/capture/script/index.ts` — `_crossOriginFrameAllowed` + the gate in
  `_iframeIsRecursable`.

### Scope note

The allowlist is threaded through the **static** single-capture path (`domotion
capture <url>`) and `DemoRecorder`. The `--scroll` path's per-segment capture
does not yet pass the allowlist, so cross-origin frames inside a scroll capture
stay raster (same-origin recursion still applies). Threading it through the scroll
executor is a minor follow-up.

### Security caveat (warned when enabled)

Disabling web security also **disables CORS** — a malicious or untrusted captured
page could then read cross-origin data and reach internal endpoints from inside
the capture browser. This is safe when capturing **your own / trusted** pages
(the common Domotion case) and a real risk for arbitrary third-party URLs.
Therefore the flag is **default-off, opt-in only**, and enabling it **prints a
visible warning** to stderr (regardless of `--quiet`).

## Tests

- `tests/features.ts` (visual, same-origin):
  - `replaced-iframe-same-origin` — `srcdoc` frame recurses to native SVG
    (pixel-identical to the prior raster, 0.00% diff).
  - `iframe-recursion-bordered` — recursion through a non-zero border + padding
    on the iframe, validating the content-box offset and the overflow clip.
- `src/capture/script/cross-origin.test.ts` (unit) — allowlist parsing + host /
  host:port / wildcard / subdomain / default-port matching.
- `tests/cross-origin-iframe-recursion.e2e.test.ts` (e2e, two localhost origins) —
  allowlist **match** recurses, **non-match** stays raster (blast-radius limit),
  `*` recurses all, no-allowlist stays raster, and **without** the launch flag the
  cross-origin document is unreadable so it stays raster.
