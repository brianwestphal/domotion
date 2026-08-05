/**
 * The live half of the paired-oracle claim (docs/107 + docs/108): what a real,
 * driven variable axis does to each instrument.
 *
 * The face oracle compares PostScript names, and a variable font has one name
 * for its whole design space — so it cannot tell two instances apart. Doc 107
 * has always said the sibling shaping oracle covers that, because it compares
 * painted glyph POSITIONS. Until this test, both halves of that sentence were
 * arguments: nothing in either corpus drove an axis Chrome honors (macOS
 * Helvetica has no `wdth` axis, and Chrome's painted width for `sans-serif` is
 * unchanged across `"wght" 100` <-> `"wght" 900`, even on `system-ui` whose
 * SFNS file IS variable).
 *
 * This drives `tests/fixtures/variable-axis/variable-axis.html` — one
 * `@font-face`, real `fvar`/`gvar`, three `font-variation-settings` locations —
 * and runs BOTH oracles' shipped comparison functions over the same instances.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { identifyFace } from "../tools/font-conformance.js";
import { compareShaping } from "../tools/shaping-conformance.js";
import {
  DEFAULT_FIXTURE,
  alignMetricsToChrome,
  familyFromFixture,
  fontBytesFromFixture,
  fontSizeFromFixture,
  measureInstances,
  ourFaceFor,
  ourGeometry,
  pairingHolds,
  type InstanceMeasurement,
  type PairVerdict,
} from "../tools/variable-axis-oracle-pair.js";
import { clearFontResolutionCaches, registerWebfont } from "../src/render/font-resolution.js";

const TEXT = "Hamburgefonstiv";

let browser: Browser;
let page: Page;
let instances: InstanceMeasurement[];
let rows: PairVerdict[];
let family = "";
let fontSize = 0;

beforeAll(async () => {
  const html = readFileSync(DEFAULT_FIXTURE, "utf-8");
  family = familyFromFixture(html);
  fontSize = fontSizeFromFixture(html);
  clearFontResolutionCaches();
  // The fixture's OWN bytes, pulled back out of its data URI — so a difference
  // between the two sides cannot be "they opened different files".
  registerWebfont(family, 400, "normal", fontBytesFromFixture(html));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 600 } });
  page = await ctx.newPage();
  instances = await measureInstances(page, DEFAULT_FIXTURE);

  const rebase = (xs: number[]): number[] =>
    (xs.length === 0 ? xs : xs.map((v) => Math.round((v - xs[0]) * 100) / 100));
  rows = [];
  for (const chromeSide of instances) {
    for (const ourSide of instances) {
      const ours = ourGeometry(TEXT, family, fontSize, ourSide.axes);
      const chromeXs = rebase(chromeSide.xs);
      // Both sides on the same metric footing before comparing — Chrome reports
      // GRID-FITTED (whole-pixel) advances wherever the host's fontconfig leaves
      // subpixel positioning off, which is the Linux default, and LINEAR ones on
      // macOS. See `alignMetricsToChrome`; a no-op on the linear side.
      const { verdict, maxDelta } = compareShaping(
        { glyphCount: chromeSide.glyphCount, faces: [], xs: chromeXs, width: chromeSide.width },
        { glyphCount: ours.glyphCount, xs: alignMetricsToChrome(chromeXs, rebase(ours.xs)), ok: ours.ok },
        0.5,
      );
      const ourFace = ourFaceFor(family, fontSize, ourSide.axes);
      rows.push({
        chromeInstance: chromeSide.id,
        ourInstance: ourSide.id,
        sameInstance: chromeSide.id === ourSide.id,
        face: identifyFace(chromeSide.face, ourFace, false) ?? "mismatch",
        chromeFace: chromeSide.face.postScriptName ?? chromeSide.face.familyName,
        ourFace: ourFace.postscriptName,
        shaping: verdict,
        maxDelta,
        chromeWidth: chromeSide.width,
        ourAdvance: ours.xs.length > 1 ? ours.xs[ours.xs.length - 1] - ours.xs[0] : null,
      });
    }
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe("the fixture drives an axis Chrome actually honors", () => {
  it("paints three visibly different widths from one @font-face", () => {
    const byId = new Map(instances.map((i) => [i.id, i]));
    const base = byId.get("base")!.width;
    const heavy = byId.get("wght800")!.width;
    const narrow = byId.get("wdth75")!.width;
    // The whole reason a webfont was needed: unlike `sans-serif` or `system-ui`
    // on macOS, these move. Generous margins — the assertion is "the axis is
    // live", not a pixel pin.
    expect(heavy).toBeGreaterThan(base + 10);
    expect(narrow).toBeLessThan(base - 10);
  });

  it("is one webfont per run, so the fixture measures the axis and not a fallback", () => {
    for (const i of instances) {
      expect(i.face.isCustomFont ?? true).toBe(true);
      expect(i.glyphCount).toBe(TEXT.length);
    }
  });
});

describe("the face oracle cannot see a wrong axis instance", () => {
  it("gives a verdict that depends only on CHROME's instance, never on ours", () => {
    // The sharp form of the blindness. Grouping by Chrome's instance leaves our
    // axis as the only thing varying inside a group — and the face oracle's
    // verdict does not move with it. So the instrument carries zero information
    // about whether we honored the author's axis.
    for (const chromeInstance of new Set(rows.map((r) => r.chromeInstance))) {
      const verdicts = new Set(rows.filter((r) => r.chromeInstance === chromeInstance).map((r) => r.face));
      expect(verdicts.size).toBe(1);
    }
  });

  it("scores an INCORRECT render as agreement — the lenient direction", () => {
    // Our side reports the base master (`OpenSans-Regular`) at every axis
    // location, because an instanced variable face keeps the base master's
    // PostScript name. So a run we painted at the wrong location still matches
    // by name. This direction holds on every platform.
    const wrongScoredAgree = rows.find((r) => r.chromeInstance === "base" && r.ourInstance === "wght800");
    expect(wrongScoredAgree?.face).toMatch(/^agree/);
  });

  it("also scores a CORRECT render as a mismatch, wherever Chrome names the instance", () => {
    // DM-1975: this direction is NOT universal, because it depends on what
    // Chrome reports rather than on what we do.
    //
    //   macOS — CoreText names the named instance Chrome snapped to, so the
    //           three runs report OpenSansRoman-ExtraBold / -CondensedRegular /
    //           OpenSans-Regular. Our base-master name then MISMATCHES the
    //           correct pair, which is the second, sharper blindness.
    //   Linux — measured in the pinned noble container: Chrome reports
    //           `OpenSans-Regular` for all three instances. There is no second
    //           direction to observe; the instrument is blind the lenient way
    //           only.
    //
    // So the precondition is derived from Chrome's own answers rather than from
    // `process.platform` — the deciding factor is how the platform's font
    // backend names a variable instance, and asserting it unconditionally made
    // this test fail on Linux for a reason that says nothing about our renderer.
    const chromeNames = new Set(instances.map((i) => i.face.postScriptName ?? i.face.familyName));
    if (chromeNames.size === 1) {
      // Guard against the assertion silently evaporating: the lenient direction
      // must still hold, and the shaping oracle below is what covers the rest.
      expect(rows.filter((r) => r.sameInstance).every((r) => r.face.startsWith("agree"))).toBe(true);
      return;
    }
    const rightScoredMismatch = rows.find((r) => r.chromeInstance === "wght800" && r.ourInstance === "wght800");
    expect(rightScoredMismatch?.face).toBe("mismatch");
  });
});

describe("the shaping oracle catches what the face oracle cannot", () => {
  it("agrees exactly when the axes match, and only then", () => {
    for (const r of rows) {
      if (r.sameInstance) expect(r.shaping).toBe("agree-exact");
      else expect(r.shaping).not.toBe("agree-exact");
    }
  });

  it("separates the two cases by orders of magnitude, not by a threshold", () => {
    const same = rows.filter((r) => r.sameInstance).map((r) => r.maxDelta ?? 0);
    const cross = rows.filter((r) => !r.sameInstance).map((r) => r.maxDelta ?? 0);
    // Sub-pixel when right; tens of pixels when wrong. For scale, the shaping
    // oracle's whole macOS baseline has a max position delta of 5.64px.
    expect(Math.max(...same)).toBeLessThan(0.5);
    expect(Math.min(...cross)).toBeGreaterThan(10);
  });
});

it("the pair holds, by the tool's own check", () => {
  const { ok, failures } = pairingHolds(rows);
  expect(failures).toEqual([]);
  expect(ok).toBe(true);
});
