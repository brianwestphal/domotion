# 23 — CSS sprite icons (off-screen text + sliced background-image)

## Context

The "image-replacement" idiom — a single CSS sprite sheet sliced into per-icon rectangles using `background-position`, with the element's accessible label hidden via `text-indent: -9999px` — is pervasive on older marketing sites (Slashdot's RSS / Facebook / LinkedIn icons in the page footer; Apple's old `.search` / `.cart` icons; many Wikipedia-skin chrome). The HTML+CSS:

```html
<a class="rss" href="…">RSS</a>
```
```css
.rss {
  background: url(/sprite.png) -20px 0 no-repeat;
  width: 20px; height: 20px;
  text-indent: -9999px; overflow: hidden;
  display: inline-block;
}
```

Chromium paints the 20×20 slice of the sprite at `(0, 0)` of the element and renders the text "RSS" 9999px to the left of the visible viewport — so the user sees only the icon. Domotion currently produces neither: the sprite is not sliced cleanly into the output and the offscreen text bleeds into the captured tree.

## Today's behavior

Two things go wrong:

**1. Intrinsic dimensions of `url()` background-images are unreliable.**
`CAPTURE_SCRIPT` (`src/capture/script/` ~2279) reads intrinsic width/height by constructing a fresh `new Image(); img.src = url;` and reading `naturalWidth` *synchronously* in the same tick. The `<img>` resource cache is not the same cache the page uses for CSS background-images, so the load is asynchronous and `naturalWidth` is `0` at read time. When `intrinsic` is `null`, `buildImagePatternDef` falls back to `tileW = basisW` (the element box), squishing the entire sprite into the 20×20 cell — which makes the negative `background-position` math meaningless and hides the icon entirely.

**2. Off-screen author text is captured and rendered.**
The element carries `text === "RSS"` and a captured `textLeft` of `~-9970`. The renderer emits the glyph paths at that absolute SVG coordinate. The output SVG's `viewBox` does not extend that far left, so most demos render as if blank — but per `overflow: hidden` Chromium would have clipped the text. We don't apply that clip, so any consumer that re-mounts the SVG inside a wider canvas (or any case where the element's own `overflow: hidden` *should* apply) leaks glyphs into the icon area.

## Proposed approach

Use the **replaced-element raster path** (doc 17) to snapshot the element's painted rect when we detect the "image-replacement" pattern. This is the same machinery we already use for `<canvas>` / `<video>` / `<iframe>`:

1. **CAPTURE_SCRIPT detection**:
   - `text-indent` parses to `≤ -1000px`, OR
   - `text-indent` parses to `< 0` AND `overflow: hidden` AND `white-space: nowrap`
   - AND the element has a non-trivial background-image OR a single visible-icon descendant.
   - When matched: tag the element with `data-domotion-rid`, record its rect, and **suppress text capture** (set `_captured.text = ''`, clear `textSegments`). Keep `aria-label` accessible by emitting an SVG `<title>` child.
2. **Post-capture pass** (`rasterizeReplacedElements` already exists): `page.screenshot({ clip: rect, omitBackground: true })`, encode as data URL, attach to `el.replacedSnapshot`.
3. **Renderer**: emit `<image href=… x=elX y=elY width=elW height=elH />` in place of the element's normal background + text emission. The text-suppression flag from step 1 prevents the glyph path emission from running.

This gets us pixel-faithful output for free (Chromium already painted exactly what we want), avoids the unreliable-intrinsic-dimension problem entirely, and handles the long-tail cases (mask-image-as-icon, inline-svg-as-icon, sprite that's actually multiple stacked layers) without per-feature work.

## Why not fix the pattern path instead?

A purely-declarative fix — repair `intrinsic` capture (e.g. by `await img.decode()` before reading naturalWidth, or by post-fetching the URL in Node and using `image-size`) and add an `overflow: hidden` + `text-indent` clip to the text emission — *would* work for the simple sprite-only case. But:

- It only addresses the sprite-via-background-image idiom; the same accessibility pattern is also used with `mask-image`, inline `<svg>`, `<i class="icon-foo">`+font-icon, and `::before { content: url(…) }`. Each would need its own per-feature suppression rule.
- The intrinsic-dimensions fix needs an async hop in CAPTURE_SCRIPT (which lives as a serialized string and currently does no awaiting), or a separate Node-side fetch (which doubles per-asset I/O).
- The text-indent clip needs a new clipPath per element, when the element box clipPath we already emit for `overflow: hidden` would be sufficient *if* the renderer respected it for glyphs (it doesn't, today).

Raster-snapshot is one code path that subsumes all of those. The cost is a `page.screenshot` per matched element, which is the same cost we already pay for replaced elements; in practice these patterns appear in low-double-digits per page, not hundreds.

## Detection rules — exact

The CAPTURE_SCRIPT predicate should match exactly when Chromium considers the element's text "off-screen accessibility text" rather than visible content. Two canonical idioms cover essentially all real-world uses:

```js
function isImageReplacementBox(cs) {
  const ti = parseFloat(cs.textIndent) || 0;
  const overflowHidden = cs.overflow === 'hidden' || cs.overflowX === 'hidden';
  const hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none';

  // Phark/Gilder-Levin: text-indent: -9999px (or very negative).
  if (ti <= -1000 && hasBgImage) return true;

  // Modern variant: text-indent: 100% + overflow: hidden + white-space: nowrap.
  if (ti < 0 && overflowHidden && cs.whiteSpace === 'nowrap' && hasBgImage) return true;

  return false;
}
```

We restrict the predicate to elements that have a `background-image`. Other "icon idioms" (font-icons via `::before`, inline SVG children) are tracked separately (DM-499) and need different handling.

## Accessibility

The author text — typically the only accessible label for the icon — must round-trip through the SVG output. Emit an SVG `<title>` child of the rasterized `<image>`:

```svg
<image href="…" …><title>RSS</title></image>
```

Screen readers and browser tooltips will surface the title string; this preserves the original a11y intent of the markup.

## DPR / scale

The replaced-element raster path already captures at the page's actual DPR (doc 17). The same logic applies here — the raster will be crisp at any output size because Chromium painted at DPR.

## Cost notes

- One `page.screenshot` per matched element (~50–200 ms each on real-world fixtures).
- Dedup is only meaningful at the per-element level; two `<a class=rss>` instances on the same page each get their own screenshot (cheap — they're 20×20).
- For a Slashdot-style footer with 6 social icons, that's 6 × ~80 ms ≈ 0.5 s added to capture. Acceptable.

## Open design questions

- **Element-icon idioms** that use `font-size: 0` or `color: transparent` instead of `text-indent`. Out of scope for this ticket — file a follow-up if seen in the wild.
- **Sprite-as-many-icons in one element** (a single `<a>` whose pseudo-elements paint several sprite slices via `::before` / `::after`). Today's code emits the host element's bg-image + each pseudo's bg-image. The raster path captures the whole element rect, including pseudos — so this works "for free" once the predicate matches.
- **Scope of `aria-label` propagation.** Always emit `<title>` from the resolved accessible name (aria-label > aria-labelledby chain > author text content)? Or just from the suppressed text content? Spec'd answer: accessible name; pragmatic answer: the suppressed text since that's what we already capture.

## Test fixture

`tests/features.ts` gains a `sprite-icon-text-indent` fixture:

```html
<style>
  .icons a {
    background: url(data:image/png;base64,…3-slot-sprite…) no-repeat;
    width: 20px; height: 20px; display: inline-block;
    text-indent: -9999px; overflow: hidden;
    margin-right: 8px;
  }
  .icons .rss { background-position: 0 0; }
  .icons .fb  { background-position: -20px 0; }
  .icons .li  { background-position: -40px 0; }
</style>
<div class="icons">
  <a class="rss" aria-label="RSS">RSS</a>
  <a class="fb"  aria-label="Facebook">Facebook</a>
  <a class="li"  aria-label="LinkedIn">LinkedIn</a>
</div>
```

The PNG-vs-SVG diff at the standard 3% threshold should pass after the change. (Pre-fix, the SVG paints either nothing or the entire sprite squished into 20×20 plus glyph "tofu" at the far left of the canvas.)

The `sprite-icon-text-indent` feature fixture (`tests/features.ts`, PNG-vs-SVG diff) covers the behavior end-to-end: the canonical `text-indent: -9999px; overflow: hidden; background: url(…)` form renders the sprite rather than glyph "tofu". (The image-replacement check is inline in the capture walker, not a standalone `isImageReplacementBox` export — the sketch above is illustrative.)

## Follow-ups to file when this lands

- **DM-499** (already filed) handles the inline-svg-as-icon variant.
- A follow-up ticket for the **font-icon** variant (`<i class="fa-cog">` + pseudo-element + icon font) — needs different handling because the icon comes from a glyph in a webfont, not an image.
- A follow-up ticket for **`text-indent: 100%; overflow: hidden; white-space: nowrap`** off-screen-with-positive-indent variant if seen in the wild — same suppression but different predicate.
- A perf bench step in `npm run demos:test` to ensure the new screenshots don't regress capture time on the existing fixture suite (which doesn't use this idiom).
