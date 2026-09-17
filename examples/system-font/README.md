# system-font text mode — examples

Basic text fixtures for the `system-font` render text mode (see
[`docs/261`](../../docs/261-system-font-render-text-mode.md)). In this mode the
SVG emits ordinary `<text>` carrying the authored `font-family` stack and the
**viewer's installed fonts** paint it — no embedded font subset, no glyph
outlines. It is an opt-in, non-pixel-faithful mode for consumers who know the
referenced fonts are present; the payoff is much smaller output.

> `--text-mode system-font` is the flag that turns off font embedding.
> `--real-text` is a *different* feature — it adds a paintless selectable/
> searchable layer while the visible text stays in the default `embedded-font`
> mode, so it does **not** stop embedding on its own.

## Fixtures

- `01-paragraph.html` — heading + body copy, an inline `<code>` run, a link.
- `02-weights-styles.html` — weights 300/400/600/700 and italic on a dark card.
- `03-serif-mono.html` — a serif article with a syntax-colored monospace block.

## Render one

```sh
npm run build
node dist/cli/index.js capture examples/system-font/01-paragraph.html \
  --text-mode system-font -o /tmp/paragraph.svg
```

## Visual check on this machine

```sh
npx tsx examples/system-font/verify.ts
```

For each fixture it screenshots the source in Chromium, renders the tree in
`system-font` mode, rasterizes that SVG in a browser using **this machine's**
system fonts, and pixel-diffs the two into `examples/system-font/output/`
(gitignored). Because the mode depends on the fonts being installed, a **low
diff on a machine that has the referenced fonts is the success signal** — it is
not a cross-machine guarantee. Measured on a macOS setup with the referenced
faces present: `02` and `03` diff at 0.000%, `01` at ~0.37% (a small run-anchor
gap at the inline-`<code>` boundary, the mode's documented run-anchor-only
positioning), at 8–69% of the embedded-font output size.
