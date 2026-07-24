/**
 * E2E guard for the shift-inclusive ("strict") region aggregates and the
 * no-motion bar built on them. The pixel pipeline runs inside a browser canvas,
 * so the only way to pin its semantics is to feed it real PNGs; these are
 * synthesised so each case isolates ONE behavior.
 *
 * The behavior under test is the blind spot the aggregates exist to close: the
 * default `regionCount` gate suppresses connected components whose pixels are
 * mostly low-severity, on the theory that they are glyph-shape / font-
 * substitution drift. That theory holds for the fidelity sweeps (our unhinted
 * outlines vs Chrome's grid-fitted raster) but not for callers comparing two
 * renders of the SAME content at the SAME positions, where a whole block can
 * change color or swap paint order and still read as low-severity. Those
 * callers read `strictRegionCount` / `strictRegionArea` /
 * `strictMaxRegionArea` and gate with `passesStrict`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comparePngs,
  passes,
  passesStrict,
  strictCapsFor,
  type CompareResult,
} from "./compare-pngs.js";

/** Score against the calibrated caps explicitly, so these cases assert the
 *  comparator's behavior rather than the host they happen to run on. */
const CAPS = strictCapsFor("darwin")!;

const W = 200;
const H = 120;

let browser: Browser;
let page: Page;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0"></body></html>`);
  dir = mkdtempSync(join(tmpdir(), "compare-pngs-e2e-"));
});

afterAll(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Paint a list of ops onto a WxH canvas in the page and write it out as a PNG.
 *  Ops are plain data so the page callback stays self-contained. */
type Op =
  | { fill: string; x: number; y: number; w: number; h: number }
  | { text: string; x: number; y: number; color: string; size: number };

let seq = 0;
async function makePng(bg: string, ops: Op[]): Promise<string> {
  const dataUrl = await page.evaluate(
    (args: { bg: string; ops: Op[]; w: number; h: number }) => {
      const c = document.createElement("canvas");
      c.width = args.w;
      c.height = args.h;
      const g = c.getContext("2d")!;
      g.fillStyle = args.bg;
      g.fillRect(0, 0, args.w, args.h);
      for (const op of args.ops) {
        if ("fill" in op) {
          g.fillStyle = op.fill;
          g.fillRect(op.x, op.y, op.w, op.h);
        } else {
          g.fillStyle = op.color;
          g.font = `${op.size}px monospace`;
          g.fillText(op.text, op.x, op.y);
        }
      }
      return c.toDataURL("image/png");
    },
    { bg, ops, w: W, h: H },
  );
  const path = join(dir, `img-${seq++}.png`);
  writeFileSync(path, Buffer.from(dataUrl.split(",")[1], "base64"));
  return path;
}

async function cmp(aPath: string, bPath: string): Promise<CompareResult> {
  return comparePngs(page, aPath, bPath, join(dir, `diff-${seq++}.png`));
}

// The two solid colors the compressor's out-of-position fixture swaps. Their
// separation (~44% of max RGB distance) sits just UNDER the comparator's 50%
// high-severity threshold, which is precisely why a full block flip between
// them reads as low-severity and gets suppressed from `regionCount`.
const RED = "#b91c1c";
const GREEN = "#15803d";

describe("strict region aggregates: what regionCount suppresses", () => {
  it("a z-order swap of equal-sized blocks reads clean on regionCount and non-zero on the strict aggregates", async () => {
    // Two overlapping bars; which one paints last is the only difference.
    const a = await makePng("#101820", [
      { fill: GREEN, x: 20, y: 30, w: 120, h: 40 },
      { fill: RED, x: 20, y: 50, w: 120, h: 40 },
    ]);
    const b = await makePng("#101820", [
      { fill: RED, x: 20, y: 50, w: 120, h: 40 },
      { fill: GREEN, x: 20, y: 30, w: 120, h: 40 },
    ]);
    const c = await cmp(a, b);

    // The documented default gate calls this clean — the bug this pins.
    expect(c.regionCount).toBe(0);
    expect(c.verdict).toBe("clean");
    expect(passes(c)).toBe(true);

    // The strict aggregates see the whole flip as one dense component.
    expect(c.strictRegionCount).toBeGreaterThan(0);
    expect(c.strictMaxRegionArea).toBeGreaterThan(CAPS.maxRegionArea);
    expect(c.strictRegionArea).toBeGreaterThan(CAPS.totalRegionArea);
    expect(passesStrict(c, CAPS)).toBe(false);

    // The caps are the same on every platform, so this flip is caught off
    // macOS too — the hole that made the bar darwin-only.
    expect(passesStrict(c, strictCapsFor("linux"))).toBe(false);
    expect(passesStrict(c, strictCapsFor("win32"))).toBe(false);
    // ...while explicitly opting out of caps still degrades to the default gate
    // rather than inventing a threshold. Pinned so that stays visible.
    expect(passesStrict(c, null)).toBe(true);
  });

  it("a pure translation beyond the shift-match radius is counted", async () => {
    // Same block, moved 12 px right — well past SHIFT_MATCH_RADIUS (2), so the
    // per-pixel shift pre-filter cannot absorb it.
    const a = await makePng("#101820", [{ fill: GREEN, x: 20, y: 30, w: 100, h: 40 }]);
    const b = await makePng("#101820", [{ fill: GREEN, x: 32, y: 30, w: 100, h: 40 }]);
    const c = await cmp(a, b);

    expect(c.strictRegionCount).toBeGreaterThan(0);
    expect(c.strictMaxRegionArea).toBeGreaterThan(CAPS.maxRegionArea);
    expect(passesStrict(c, CAPS)).toBe(false);
  });

  it("a translation WITHIN the shift-match radius is still absorbed — the pre-filter is not lifted", async () => {
    // 1 px. Every differing pixel finds a near-match in the ±2 px neighborhood
    // of the other image, so it never reaches any region count. This layer
    // stays on for strict callers by design: transform-composed groups
    // genuinely rasterize a sub-pixel phase off directly-placed ones.
    const a = await makePng("#101820", [{ fill: GREEN, x: 20, y: 30, w: 100, h: 40 }]);
    const b = await makePng("#101820", [{ fill: GREEN, x: 21, y: 30, w: 100, h: 40 }]);
    const c = await cmp(a, b);

    expect(c.shiftedPixels).toBeGreaterThan(0);
    expect(c.strictRegionCount).toBe(0);
    expect(c.strictRegionArea).toBe(0);
    expect(c.strictMaxRegionArea).toBe(0);
    expect(passesStrict(c, CAPS)).toBe(true);
  });

  it("scattered sub-floor noise stays forgiven — the area floor still applies", async () => {
    // Isolated single pixels, far enough apart that the 3 px dilation cannot
    // merge them into a component reaching MIN_REGION_AREA (15).
    const dots = (offset: number): Op[] =>
      Array.from({ length: 6 }, (_, i) => ({
        fill: i % 2 === 0 ? "#ffffff" : "#000000",
        x: 10 + i * 30 + offset, y: 10 + i * 15, w: 1, h: 1,
      }));
    const a = await makePng("#808080", dots(0));
    const b = await makePng("#808080", dots(60));
    const c = await cmp(a, b);

    expect(c.nonAaPixels).toBeGreaterThan(0);
    expect(c.strictRegionCount).toBe(0);
    expect(c.strictMaxRegionArea).toBe(0);
    expect(passesStrict(c, CAPS)).toBe(true);
  });

  it("identical images score zero on every strict aggregate", async () => {
    const ops: Op[] = [
      { fill: RED, x: 20, y: 20, w: 80, h: 30 },
      { text: "hello world", x: 20, y: 90, color: "#e2e8f0", size: 14 },
    ];
    const a = await makePng("#101820", ops);
    const b = await makePng("#101820", ops);
    const c = await cmp(a, b);

    expect(c.strictRegionCount).toBe(0);
    expect(c.strictRegionArea).toBe(0);
    expect(c.strictMaxRegionArea).toBe(0);
    expect(passesStrict(c, CAPS)).toBe(true);
  });
});

describe("strict aggregates are derived, never independent", () => {
  it("count and area are exactly the primary numbers plus the suppressed ones", async () => {
    // One suppressed low-severity block plus one high-severity block, so both
    // buckets are non-empty in the same comparison.
    const a = await makePng("#101820", [
      { fill: GREEN, x: 10, y: 10, w: 60, h: 40 },
      { fill: "#ffffff", x: 120, y: 10, w: 60, h: 40 },
    ]);
    const b = await makePng("#101820", [
      { fill: RED, x: 10, y: 10, w: 60, h: 40 },
      { fill: "#000000", x: 120, y: 10, w: 60, h: 40 },
    ]);
    const c = await cmp(a, b);

    expect(c.shiftyRegionCount).toBeGreaterThan(0);
    expect(c.regionCount).toBeGreaterThan(0);
    expect(c.strictRegionCount).toBe(c.regionCount + c.shiftyRegionCount);
    expect(c.strictRegionArea).toBe(c.totalChangedArea + c.shiftyRegionArea);
    // The largest counted component is at least as big as any single bucket
    // and no bigger than the total.
    expect(c.strictMaxRegionArea).toBeLessThanOrEqual(c.strictRegionArea);
    expect(c.strictMaxRegionArea).toBeGreaterThan(0);
  });

  it("the byte-identical fast path reports the same zeros as a real comparison", async () => {
    const a = await makePng("#101820", [{ fill: RED, x: 10, y: 10, w: 60, h: 40 }]);
    // Same bytes on both sides exercises the early return, which builds its
    // result by hand and so is the one place a new field can be forgotten.
    const c = await cmp(a, a);
    expect(c.strictRegionCount).toBe(0);
    expect(c.strictRegionArea).toBe(0);
    expect(c.strictMaxRegionArea).toBe(0);
    expect(passesStrict(c, CAPS)).toBe(true);
  });
});
