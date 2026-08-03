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
import { existsSync, readFileSync } from "node:fs";
import * as fontkit from "fontkit";
import {
  DEFAULT_FIXTURE,
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
