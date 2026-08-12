/**
 * Unit coverage for the variable-axis fixture and the half of the paired-oracle
 * claim that needs no browser.
 *
 * The face conformance oracle (docs/107) is name-blind to variable instances:
 * one PostScript name covers every point in a variable font's design space, so
 * two runs instanced at different axis locations report the same face. That was
 * documented but UNTESTED — nothing in either corpus drove an axis Chrome
 * honors, because the macOS system faces do not respond to one.
 *
 * These assertions pin the two facts that make the fixture worth having:
 *
 *   1. the embedded webfont really is variable (not instanced by the subsetter),
 *      and reports ONE PostScript name at every axis location we ask for;
 *   2. our RENDERER's geometry moves when the axis moves — so the geometry
 *      signal the shaping oracle reads is really there to be read.
 *
 * The live Chrome half — that Chrome's painted geometry moves the same way, and
 * that `identifyFace` cannot see any of it — is `variable-axis-oracle-pair.e2e.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as fontkit from "fontkit";
import {
  DEFAULT_FIXTURE,
  alignMetricsToChrome,
  chromeUsesGridFittedAdvances,
  quantizeAdvances,
  familyFromFixture,
  fontBytesFromFixture,
  fontSizeFromFixture,
  ourFaceFor,
  ourGeometry,
  parseSettings,
} from "../tools/variable-axis-oracle-pair.js";
import { clearFontResolutionCaches, registerWebfont } from "../src/render/font-resolution.js";

const html = existsSync(DEFAULT_FIXTURE) ? readFileSync(DEFAULT_FIXTURE, "utf-8") : "";
const TEXT = "Hamburgefonstiv";

describe("the fixture", () => {
  it("keeps production TypeScript free of literal NUL bytes", () => {
    // Oxc accepted the NUL embedded in shaping-conformance.ts on macOS/Linux,
    // but rejected that module during Vitest import on Windows before any test
    // was collected. `\\0` produces the same runtime separator portably.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (/\.tsx?$/.test(name) && readFileSync(path).includes(0)) offenders.push(path);
      }
    };
    walk("src");
    walk("tools");
    expect(offenders).toEqual([]);
  });

  it("keeps importable oracle modules free of CLI hashbangs", () => {
    // These files are both command entry points and libraries imported by the
    // paired-oracle Vitest suite. On a Windows CRLF checkout, Oxc can leave the
    // hashbang's carriage return behind as an unexpected token during import.
    for (const path of [
      "tools/font-conformance.ts",
      "tools/shaping-conformance.ts",
      "tools/variable-axis-oracle-pair.ts",
    ]) {
      expect(readFileSync(path, "utf-8").startsWith("#!")).toBe(false);
    }
  });

  it("exists and is self-contained", () => {
    expect(existsSync(DEFAULT_FIXTURE)).toBe(true);
    // A data URI rather than a sibling file, deliberately: Chrome treats a
    // file:// page as an opaque origin and refuses a cross-origin font fetch,
    // so a relative `src` would silently fall back to a system face and the
    // fixture would measure nothing while looking fine.
    expect(html).toMatch(/@font-face/);
    expect(html).toMatch(/url\(data:font\/[a-z0-9-]+;base64,/);
    expect(html).toContain(TEXT);
  });

  it("paints the same text at three different axis locations", () => {
    const settings = [...html.matchAll(/data-settings='([^']*)'/g)].map((m) => m[1]);
    expect(settings).toEqual(["normal", '"wght" 800', '"wdth" 75']);
    // Whitespace-free: the shaping oracle's corpus excludes runs containing
    // whitespace (Chrome counts space glyphs, our renderer usually emits no
    // position for them), so a fixture with a space could not be compared by
    // the instrument it exists to exercise.
    expect(TEXT).not.toMatch(/\s/);
  });
});

describe("the embedded face", () => {
  const font = html === "" ? null : (fontkit.create(fontBytesFromFixture(html)) as unknown as {
    postscriptName: string;
    variationAxes: Record<string, { min: number; max: number; default: number }>;
  });

  it("survived subsetting as a VARIABLE font", () => {
    // An instanced subset has no axis to drive, which would make the fixture
    // inert while still rendering perfectly well.
    expect(font).not.toBeNull();
    expect(Object.keys(font!.variationAxes)).toEqual(expect.arrayContaining(["wght", "wdth"]));
  });

  it("covers the axis locations the fixture asks for", () => {
    for (const s of ['"wght" 800', '"wdth" 75']) {
      for (const [tag, value] of Object.entries(parseSettings(s) ?? {})) {
        const axis = font!.variationAxes[tag];
        expect(axis).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(axis.min);
        expect(value).toBeLessThanOrEqual(axis.max);
        // An instance that equals the default would move nothing, and the
        // fixture would prove nothing while passing.
        expect(value).not.toBe(axis.default);
      }
    }
  });
});

describe("our side is name-blind and geometry-live", () => {
  let family = "";
  let fontSize = 0;

  beforeAll(() => {
    family = familyFromFixture(html);
    fontSize = fontSizeFromFixture(html);
    clearFontResolutionCaches();
    registerWebfont(family, 400, "normal", fontBytesFromFixture(html));
  });

  it("reports ONE PostScript name at every axis location — the blindness itself", () => {
    const names = [null, { wght: 800 }, { wdth: 75 }]
      .map((axes) => ourFaceFor(family, fontSize, axes).postscriptName);
    expect(names[0]).not.toBeNull();
    expect(new Set(names).size).toBe(1);
  });

  it("moves its painted geometry when the axis moves", () => {
    // The other half of the pair. If this were flat, the shaping oracle would
    // have nothing to catch either, and the face oracle's blind spot would be
    // uncovered rather than covered.
    const advance = (axes: Record<string, number> | null): number => {
      const g = ourGeometry(TEXT, family, fontSize, axes);
      expect(g.ok).toBe(true);
      expect(g.xs.length).toBe(TEXT.length);
      return g.xs[g.xs.length - 1] - g.xs[0];
    };
    const base = advance(null);
    const heavy = advance({ wght: 800 });
    const narrow = advance({ wdth: 75 });
    // Both axes move the run, and in the directions the axis names imply.
    expect(heavy).toBeGreaterThan(base + 1);
    expect(narrow).toBeLessThan(base - 1);
  });
});

// DM-1975: the metric footing the two sides are compared on.
//
// Chrome reports GRID-FITTED (whole-pixel) advances wherever the host's
// fontconfig leaves subpixel positioning off — the Linux default — and LINEAR
// (fractional) ones on macOS. Comparing our linear positions against grid-fitted
// ones reported a ~1.9 px drift on the CORRECT axis instance, which reads as
// "our renderer ignores the author's axis" when the axis is honored exactly.
//
// These pin the alignment as a rule rather than a tolerance: it is detected from
// Chrome's own numbers, it is a no-op on the linear side, and it quantizes
// ADVANCES (which then accumulate) rather than positions.
describe("aligning our metrics to Chrome's (grid-fitted vs linear advances)", () => {
  it("detects grid-fitted advances, and does not mistake linear ones for them", () => {
    expect(chromeUsesGridFittedAdvances([0, 35, 62, 106, 135])).toBe(true);
    expect(chromeUsesGridFittedAdvances([0, 35.39, 62.06, 106.5, 135.87])).toBe(false);
    // Fractional POSITIONS with whole-pixel advances still count: the run may
    // start at a fractional page offset, and only the deltas are quantized.
    expect(chromeUsesGridFittedAdvances([0.5, 35.5, 62.5, 106.5])).toBe(true);
    // Too short to be evidence of anything.
    expect(chromeUsesGridFittedAdvances([0, 35])).toBe(false);
  });

  it("quantizes ADVANCES and re-accumulates, not positions", () => {
    // 0.6 + 0.6 + 0.6: rounding positions gives [0, 1, 1, 2]; rounding advances
    // and accumulating gives [0, 1, 2, 3]. Skia rounds the advance, which is why
    // the drift grows along the run instead of staying bounded.
    expect(quantizeAdvances([0, 0.6, 1.2, 1.8])).toEqual([0, 1, 2, 3]);
    expect(quantizeAdvances([])).toEqual([]);
    expect(quantizeAdvances([7.25])).toEqual([7.25]);
  });

  it("reproduces Chrome's Linux positions exactly from our linear ones", () => {
    // The real measurement, from the pinned noble container at 48px: our linear
    // advances, quantized, ARE Chrome's positions — every one, zero delta. That
    // exactness is the claim; a threshold would have hidden whether the rule was
    // right or merely close.
    const chrome = [0, 35, 62, 106, 135, 164, 184, 210, 237, 253, 282, 311, 334, 351, 363];
    const ours = [0, 35.39, 62.06, 106.5, 135.87, 165.3, 184.92, 210.98, 237.94,
      254.09, 282.96, 312.4, 335.27, 352.38, 364.5];
    expect(alignMetricsToChrome(chrome, ours)).toEqual(chrome);
  });

  it("leaves our geometry untouched when Chrome reports linear advances", () => {
    // macOS must be unaffected — the comparison there is already sub-pixel and
    // this must not blunt it.
    const chrome = [0, 35.39, 62.06, 106.5];
    const ours = [0, 35.4, 62.1, 106.55];
    expect(alignMetricsToChrome(chrome, ours)).toEqual(ours);
  });
});
