/**
 * A per-side fingerprint that answers "did THIS image change between runs?"
 *
 * DM-1874. A baseline stores one number per fixture — the distance between
 * Chrome's `expected.png` and our `actual.svg` — and that number rises when
 * EITHER side moves. The report cannot say which, so an oracle wobble and a
 * renderer regression are indistinguishable, and the cost of telling them apart
 * is a bisect. One investigation was spent on a "regression" that turned out to
 * be Chrome painting U+2090–U+2093 from a different face on one CI run: our
 * output was unchanged, Chrome's differed by 607 px.
 *
 * ## Why not a content hash
 *
 * CI raster is not bit-stable. The same commit rendered twice on the same runner
 * differed by 280 px of sub-pixel antialiasing, so a SHA over the bytes reports
 * "changed" on every run and classifies nothing. The digest therefore has to be
 * deliberately lossy: coarse enough to survive AA jitter, fine enough that a
 * different FACE — which is what actually moves in these events — falls out.
 *
 * ## What it is
 *
 * Downsample to a fixed 16×16 grid by box-averaging luma, then quantise each
 * cell to 4 bits. A whole cell must shift by ~1/16 of the luma range before its
 * nibble changes, which absorbs AA noise spread across a cell while a glyph
 * swapped for a differently-shaped one moves several cells past that threshold.
 *
 * Fixed grid rather than fixed cell size, so the digest is comparable across
 * fixtures of different dimensions and a resized fixture does not read as a
 * content change on every cell.
 *
 * ## What it is NOT
 *
 * Not a similarity metric and not a quality signal — it answers one yes/no
 * question, "is this side the same as last time". Two images with equal digests
 * are not necessarily identical; the tolerance is the point. It should never be
 * used to decide pass/fail, only to attribute a movement that some other metric
 * already found.
 *
 * ## The sensitivity floor, measured — read this before trusting a "same"
 *
 * DM-1897. On a 1024x768 fixture, perturbing scattered pixels by ±8 intensity
 * (the magnitude CI antialiasing actually varies by) moves this many of the 256
 * cells:
 *
 *     ~diffPct 0.007   →   0 cells    INVISIBLE
 *     ~diffPct 0.036   →   2 cells
 *     ~diffPct 0.18    →   3 cells
 *     ~diffPct 1.45    →  21 cells
 *
 * So **below roughly 0.04 diffPct at AA magnitude, "same" means "not detected",
 * not "identical"**. High-contrast changes are seen far sooner — 50 full-black
 * pixels (0.006% of the image) already move a cell — but that is not the case
 * that matters here, because AA jitter is exactly what the quantisation is
 * built to swallow.
 *
 * The practical consequence: for a fixture whose metric moves by a few
 * hundredths of a percent, `attributeMovement` returning `neither` is NOT
 * evidence that the comparator is at fault. It is equally consistent with
 * ordinary raster jitter that this digest cannot resolve. Both readings stay
 * open, and saying so is the point — the alternative is a confident wrong
 * attribution, which is the failure this whole mechanism exists to prevent.
 * (I made exactly that misreading on first use.)
 */

/** Grid the image is box-averaged down to. 16×16 = 256 cells = 128 hex chars. */
const GRID = 16;

/** Quantisation step: 4 bits, so a cell must move ~1/16 of full range to flip. */
const LEVELS = 16;

/**
 * Perceptual digest of raw RGBA pixels.
 *
 * `width`/`height` are the source dimensions; `data` is RGBA8 in row-major order
 * (what `ImageData.data` and most PNG decoders give). Returns a lower-case hex
 * string, or `""` when the input is empty — an empty digest compares unequal to
 * everything, which is the safe direction: it degrades to "cannot attribute"
 * rather than to a false "unchanged".
 */
export function perceptualDigest(data: Uint8Array | Uint8ClampedArray, width: number, height: number): string {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return "";

  const sums = new Float64Array(GRID * GRID);
  const counts = new Uint32Array(GRID * GRID);

  for (let y = 0; y < height; y++) {
    // `min` guards the bottom/right edge: with a non-multiple size the last
    // source row can otherwise index one cell past the grid.
    const gy = Math.min(GRID - 1, Math.floor((y * GRID) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GRID - 1, Math.floor((x * GRID) / width));
      const i = (y * width + x) * 4;
      // Composite against white before taking luma. Text fixtures are mostly
      // transparent-or-white background, and ignoring alpha would make a
      // transparent region and a white one hash differently for no visual
      // reason. Rec. 601 luma — the exact coefficients do not matter here, only
      // that they are stable.
      const a = data[i + 3] / 255;
      const r = data[i] * a + 255 * (1 - a);
      const g = data[i + 1] * a + 255 * (1 - a);
      const b = data[i + 2] * a + 255 * (1 - a);
      const cell = gy * GRID + gx;
      sums[cell] += 0.299 * r + 0.587 * g + 0.114 * b;
      counts[cell]++;
    }
  }

  let out = "";
  for (let c = 0; c < GRID * GRID; c++) {
    const mean = counts[c] > 0 ? sums[c] / counts[c] : 255;
    // Clamp before quantising: a mean of exactly 255 would otherwise produce
    // level 16, which is not a hex digit.
    const level = Math.min(LEVELS - 1, Math.floor((mean / 256) * LEVELS));
    out += level.toString(16);
  }
  return out;
}

/** How two runs of one side compare. */
export type SideMovement = "same" | "moved" | "unknown";

/** Compare one side's digest across two runs. Missing on either side is
 *  `"unknown"` — an older baseline predates the field, and guessing there would
 *  manufacture exactly the false confidence this exists to remove. */
export function compareDigest(a: string | undefined, b: string | undefined): SideMovement {
  if (a == null || b == null || a === "" || b === "") return "unknown";
  return a === b ? "same" : "moved";
}

/**
 * Attribute a fixture's movement to a side.
 *
 * The classification a report can act on:
 *
 *   `oracle`   Chrome's expected.png moved and ours did not — not a code
 *              regression. The thing that cost a bisect.
 *   `renderer` ours moved and Chrome's did not — the real signal.
 *   `both`     both moved; genuinely ambiguous.
 *   `neither`  neither digest moved, yet the metric changed. Two readings stay
 *              open and the second is the likelier one for small movements:
 *              the metric is not a function of the two images (a comparator
 *              change), OR the change is real but below this digest's
 *              sensitivity floor — see the measured table above, where an
 *              AA-magnitude move worth ~0.007 diffPct registers as zero cells.
 *              Do NOT read `neither` as "the images are identical".
 *   `unknown`  digests unavailable on one side.
 */
export function attributeMovement(
  expectedBefore: string | undefined, expectedAfter: string | undefined,
  actualBefore: string | undefined, actualAfter: string | undefined,
): "oracle" | "renderer" | "both" | "neither" | "unknown" {
  const exp = compareDigest(expectedBefore, expectedAfter);
  const act = compareDigest(actualBefore, actualAfter);
  if (exp === "unknown" || act === "unknown") return "unknown";
  if (exp === "moved" && act === "moved") return "both";
  if (exp === "moved") return "oracle";
  if (act === "moved") return "renderer";
  return "neither";
}
