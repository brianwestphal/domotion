// An `@font-face` webfont's embedded subset is built from the webfont's own
// bytes (hb-subset, doc 99), not rebuilt by svg2ttf from captured outlines.
// Chromium paints the webfont's own `glyf`; svg2ttf 6.1.0 re-encodes it lossily
// (it drops on-curve points within 1.1 units of their off-curve neighbors'
// midpoint), which moved antialiased pixels in a DomotionFixtureMono "0".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearEmbeddedFontBuilder,
  getBuiltEmbeddedFontFaceCss,
  getEmbeddedFontBuildDiagnostics,
  takeEmbeddedFontEmbeddingRestrictions,
  trackGlyphInEmbedFont,
  webfontEmbeddingSourceFor,
  webfontHintedSourceFor,
  type PathCommand,
} from "./embedded-font-builder.js";
import { sfntOs2FsType, withOs2FsType } from "./hb-subset.js";
import { wrapInTtc } from "./synth-test-fonts.js";

const mono = readFileSync(
  fileURLToPath(new URL("../../assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url)),
);
const ZERO_GID = 737;

interface Glyph {
  path: { commands: PathCommand[]; toSVG(): string };
  advanceWidth: number;
}
interface WebfontLike {
  webfontBuffer?: Buffer;
  postscriptName?: string;
  familyName?: string;
  unitsPerEm: number;
  _appliedVariationAxes?: Record<string, number>;
  getGlyph(id: number): Glyph;
}

function webfont(bytes: Buffer): WebfontLike {
  const font = fontkit.create(bytes) as unknown as WebfontLike;
  font.webfontBuffer = bytes;
  return font;
}

function sfntTable(bytes: Buffer, tag: string): Buffer | null {
  const count = bytes.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    if (bytes.toString("latin1", record, record + 4) !== tag) continue;
    const offset = bytes.readUInt32BE(record + 8);
    return bytes.subarray(offset, offset + bytes.readUInt32BE(record + 12));
  }
  return null;
}

/** The raw `glyf` record of `gid` (loca-addressed). */
function glyfRecord(bytes: Buffer, gid: number): Buffer {
  const longLoca = sfntTable(bytes, "head")!.readInt16BE(50) === 1;
  const loca = sfntTable(bytes, "loca")!;
  const at = (i: number) => (longLoca ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2);
  return sfntTable(bytes, "glyf")!.subarray(at(gid), at(gid + 1));
}

function decodeFirstFont(css: string): Buffer {
  const m = /data:font\/ttf;base64,([A-Za-z0-9+/=]+)/.exec(css);
  if (m == null) throw new Error("no embedded font data: URI found");
  return Buffer.from(m[1], "base64");
}

function trackZero(key: string, font: WebfontLike): void {
  const glyph = font.getGlyph(ZERO_GID);
  trackGlyphInEmbedFont(key, font.unitsPerEm, 800, -200, ZERO_GID, glyph.path.commands, glyph.advanceWidth, {
    italic: false,
    weight: 400,
    hintedSource: webfontHintedSourceFor(font),
    webfontSource: webfontEmbeddingSourceFor(font),
  });
}

describe("webfontHintedSourceFor", () => {
  it("names a single-face sfnt webfont by content, face 0, with its bytes", () => {
    const font = webfont(mono);
    const source = webfontHintedSourceFor(font);
    expect(source).toEqual({
      path: webfontEmbeddingSourceFor(font)!.id,
      postscriptName: font.postscriptName,
      faceIndex: 0,
      variationAxes: null,
      data: mono,
    });
    expect(source!.path).toMatch(/^webfont#[0-9a-f]{64}$/);
  });

  it("carries the axis location the instance resolved to", () => {
    const font = webfont(mono);
    font._appliedVariationAxes = { wght: 650 };
    expect(webfontHintedSourceFor(font)?.variationAxes).toEqual({ wght: 650 });
  });

  it("declines non-webfonts, WOFF and collections, which stay on svg2ttf", () => {
    expect(webfontHintedSourceFor(null)).toBeNull();
    expect(webfontHintedSourceFor({ postscriptName: "X" })).toBeNull();
    const woff = Buffer.from(mono);
    woff.write("wOFF", 0, "latin1");
    expect(webfontHintedSourceFor({ webfontBuffer: woff })).toBeNull();
    expect(webfontHintedSourceFor({ webfontBuffer: wrapInTtc([mono]) })).toBeNull();
    expect(webfontHintedSourceFor({ webfontBuffer: Buffer.alloc(2) })).toBeNull();
  });
});

describe("embedded subset of an @font-face webfont", () => {
  const previous = process.env.DOMOTION_HINTED_SUBSET;
  beforeEach(() => clearEmbeddedFontBuilder());
  afterEach(() => {
    clearEmbeddedFontBuilder();
    if (previous === undefined) delete process.env.DOMOTION_HINTED_SUBSET;
    else process.env.DOMOTION_HINTED_SUBSET = previous;
  });

  it("hb-subsets the webfont's own bytes, keeping the glyph record byte-for-byte", () => {
    trackZero("wf|w=400", webfont(mono));
    const out = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    const [diagnostic] = getEmbeddedFontBuildDiagnostics();
    expect(diagnostic).toEqual(
      expect.objectContaining({ selectedBuilder: "hb-subset", faceIndex: 0, hintedSourceDisqualifiedReasons: [] }),
    );
    expect(diagnostic.sourcePath).toMatch(/^webfont#/);
    expect(glyfRecord(out, ZERO_GID).equals(glyfRecord(mono, ZERO_GID))).toBe(true);
  });

  it("negative control: the svg2ttf rebuild moves the zero's on-curve points by half a unit", () => {
    process.env.DOMOTION_HINTED_SUBSET = "0";
    trackZero("wf|w=400", webfont(mono));
    const out = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(getEmbeddedFontBuildDiagnostics()[0].selectedBuilder).toBe("svg2ttf");
    const source = webfont(mono).getGlyph(ZERO_GID).path.toSVG();
    const rebuilt = (fontkit.create(out) as unknown as WebfontLike).getGlyph(1).path.toSVG();
    expect(source).toContain("Q240 340 240 368Q");
    expect(rebuilt).toContain("Q240 340 240 367.5Q");
    expect(rebuilt).not.toBe(source);
  });

  it("disqualifies an entry that mixes two webfont buffers", () => {
    const other = Buffer.from(withOs2FsType(mono, 0x0008));
    trackZero("mixed|w=400", webfont(mono));
    trackZero("mixed|w=400", webfont(other));
    getBuiltEmbeddedFontFaceCss();
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(
      expect.objectContaining({
        selectedBuilder: "svg2ttf",
        hintedSourceDisqualifiedReasons: ["source-axis-disagreement"],
      }),
    );
  });

  it("keeps the webfont's fsType and reports it once, as a webfont rather than a file", () => {
    const restricted = withOs2FsType(mono, 0x0002);
    trackZero("wf|w=400", webfont(restricted));
    expect(sfntOs2FsType(decodeFirstFont(getBuiltEmbeddedFontFaceCss()))).toBe(0x0002);
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([
      expect.objectContaining({ source: "webfont", fsType: 0x0002, restrictions: ["restricted-license"] }),
    ]);
  });

  it("restates the fsType from the webfont bytes when the entry falls back to svg2ttf", () => {
    process.env.DOMOTION_HINTED_SUBSET = "0";
    trackZero("wf|w=400", webfont(withOs2FsType(mono, 0x0002)));
    expect(sfntOs2FsType(decodeFirstFont(getBuiltEmbeddedFontFaceCss()))).toBe(0x0002);
  });
});
