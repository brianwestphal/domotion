# SVG optimization (svgo + svgz)

Domotion provides two opt-in size-reduction passes for the rendered SVG. They compose: svgo first, then svgz.

## `optimizeSvg(svg: string): string`

SVGO post-pass tuned for the kind of output Domotion produces (path-mode text dominates the byte budget). Plugin set:

| Plugin | What it does for Domotion |
|---|---|
| `convertPathData` (`floatPrecision: 1`, `transformPrecision: 3`, `makeArcs: false`) | Trims glyph path coordinates and converts to relative commands. The biggest single win on text-heavy captures. `makeArcs: false` keeps fontkit-extracted cubics intact — converting them to arcs is lossy and visually shifts curves. |
| `convertTransform` | Collapses redundant transform chains into a single matrix where possible. |
| `minifyStyles` | Strips whitespace and comments from inline `<style>` blocks. |
| `removeComments` | Strips `<!-- ... -->` author comments left over from the source DOM. |
| `removeEmptyAttrs` | Drops attributes that ended up empty after other passes. |

Multipass is on (`multipass: true`), so the plugin chain is re-run until no further reductions land.

### What we deliberately do **not** enable

- **`removeUnknownsAndDefaults`** and **`removeUselessStrokeAndFill`** would strip attributes that look default but are semantically meaningful inside Domotion's keyframe/symbol structure (especially under `data-animid` groups and `<use>`-via-`<symbol>` glyphs).
- **`mergePaths`** / **`mergeStyles`** — merging would break the per-character `<use>` deduplication the renderer relies on for animated text.
- **`removeViewBox`** — `viewBox` is what makes the output scale crisply at any size.

The current plugin list is conservative on purpose. Adding plugins requires a visual-regression sweep across `tests/features.ts`, `tests/showcase.tsx`, and `tests/real-world.tsx`.

## `gzipSvg(svg: string): Buffer`

Pure `zlib.gzipSync` wrapper. The output is a binary `Buffer` (gzip's framing bytes are not valid UTF-8), starts with the gzip magic `1F 8B`, and round-trips losslessly under `gunzip`.

Naming convention: write the bytes to a file with the `.svgz` extension. All modern browsers (Chrome / Firefox / Safari / Edge) decompress `.svgz` transparently when served with `Content-Encoding: gzip` and most also sniff the magic bytes when the encoding header is missing.

Typical size ratio on a Domotion capture, in bytes:

| Form | Relative size |
|---|---|
| Raw SVG | 1.0× |
| `optimizeSvg(svg)` | ~0.3–0.6× |
| `gzipSvg(svg)` | ~0.15–0.25× |
| `gzipSvg(optimizeSvg(svg))` | ~0.07–0.12× |

svgz on an un-svgo'd SVG gzips reasonably (it's text), but running svgo first gives a meaningfully smaller payload because svgo collapses path data into a tighter representation that gzip compresses further.

## CLI integration

Both subcommands honor `.svgz` auto-detection from `-o`:

```
domotion capture ./hero.html -o hero.svgz        # gzipped svg; svgo implied
domotion capture ./hero.html -o hero.svg --optimize  # svgo'd plain svg
domotion capture ./hero.html -o hero.svgz --no-optimize  # gzip only, no svgo
```

Rules:

1. `.svgz` extension on `-o` triggers gzip output.
2. svgz implies `--optimize` unless `--no-optimize` is also passed. (Rationale: the common case is "I want it as small as possible"; opting out is one extra flag.)
3. `--optimize` and `--no-optimize` are mutually exclusive — combining them is a CLI usage error.
4. Stdout output (`-o -` or no `-o`) writes the raw bytes (gzip or text) directly; pipe through `gunzip -c` or pipe into a `.svgz`-named file.
5. The "Wrote …" stderr line reports `KB svgz` vs `KB` so the user can see at a glance which form landed on disk.

The `animate` subcommand follows the same rules. The JSON config's `"optimize": true` is still honored; `--no-optimize` on the command line wins over the config when the output is `.svgz` (treats the config as a default the user is overriding).

## Public API

```ts
import { optimizeSvg, gzipSvg } from "domotion-svg";

const svg = elementTreeToSvg(tree, w, h);
const small = optimizeSvg(svg);                  // string → string
const bytes = gzipSvg(small);                    // string → Buffer
fs.writeFileSync("out.svgz", bytes);
```

The two functions are deliberately orthogonal: callers compose them in whichever order makes sense, and `optimizeSvg` keeps a clean `string → string` type. `gzipSvg` always returns `Buffer` because the bytes are not valid UTF-8.

The capture and render APIs (`captureElementTree`, `elementTreeToSvg`, `wrapSvg`, `generateAnimatedSvg`) are not wired to emit `.svgz` directly — gzip is a write-time concern, not a render-time concern. Callers do their own writes today, and `gzipSvg(buffer)` slots in at that boundary.
