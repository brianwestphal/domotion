// DM-DJKYRC: the embedded `@font-face` must not state an embedding permission
// its source face did not grant. The hb-subset path keeps the source OS/2
// table; the svg2ttf rebuild writes `fsType` 0 unless the source value is
// carried over. `fsType` is metadata only (Chromium does not read it for
// webfonts; OTS only normalizes its bits), so these tests assert the bytes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fontkit from "fontkit";
import {
  clearEmbeddedFontBuilder,
  clearHintedOutlineGuardMemo,
  embeddingRestrictionsForFsType,
  getBuiltEmbeddedFontFaceCss,
  getEmbeddedFontBuildDiagnostics,
  restoreEmbeddedFonts,
  snapshotEmbeddedFonts,
  takeEmbeddedFontEmbeddingRestrictions,
  trackGlyphInEmbedFont,
  webfontEmbeddingSourceFor,
} from "./embedded-font-builder.js";
import { injectPuaCmap, sfntOs2FsType, withOs2FsType, hbSubsetRetainGids } from "./hb-subset.js";
import { buildStaticHintedFont, wrapInTtc } from "./synth-test-fonts.js";

const TRI = [
  { command: "moveTo" as const, args: [100, 0] },
  { command: "lineTo" as const, args: [500, 0] },
  { command: "lineTo" as const, args: [300, 700] },
  { command: "closePath" as const, args: [] },
];

/** Restricted License embedding (bit 1). */
const FS_TYPE_RESTRICTED = 0x0002;

/** A static hinted font with an OS/2 table declaring `fsType`. The synthetic
 *  builder emits no OS/2, so `injectPuaCmap` synthesizes one (fsType 0) and
 *  `withOs2FsType` then sets the value under test. */
function fontWithFsType(fsType: number): Buffer {
  const withOs2 = injectPuaCmap(buildStaticHintedFont(), new Map([[0x41, 1]]));
  return withOs2FsType(withOs2, fsType);
}

function decodeFirstFont(css: string): Buffer {
  const m = /data:font\/ttf;base64,([A-Za-z0-9+/=]+)/.exec(css);
  if (m == null) throw new Error("no embedded font data: URI found");
  return Buffer.from(m[1], "base64");
}

describe("sfntOs2FsType / withOs2FsType", () => {
  it("reads null for a face with no OS/2 table", () => {
    expect(sfntOs2FsType(buildStaticHintedFont())).toBeNull();
    expect(sfntOs2FsType(Buffer.alloc(4))).toBeNull();
  });

  it("writes the value, keeps the font parseable, and leaves the other tables alone", () => {
    const source = injectPuaCmap(buildStaticHintedFont(), new Map([[0x41, 1]]));
    expect(sfntOs2FsType(source)).toBe(0);
    const restricted = withOs2FsType(source, FS_TYPE_RESTRICTED);
    expect(sfntOs2FsType(restricted)).toBe(FS_TYPE_RESTRICTED);
    const font = fontkit.create(restricted) as unknown as {
      "OS/2": { fsType: unknown };
      glyphForCodePoint(cp: number): { id: number };
    };
    expect(font.glyphForCodePoint(0x41).id).toBe(1);
    // Same value in, same bytes out: no rebuild.
    expect(withOs2FsType(restricted, FS_TYPE_RESTRICTED)).toBe(restricted);
    // No OS/2 to write into: unchanged.
    const bare = buildStaticHintedFont();
    expect(withOs2FsType(bare, FS_TYPE_RESTRICTED)).toBe(bare);
  });

  it("reads the member a TTC face index names", () => {
    const ttc = wrapInTtc([fontWithFsType(0), fontWithFsType(FS_TYPE_RESTRICTED)]);
    expect(sfntOs2FsType(ttc, 0)).toBe(0);
    expect(sfntOs2FsType(ttc, 1)).toBe(FS_TYPE_RESTRICTED);
    expect(sfntOs2FsType(ttc, 2)).toBeNull();
  });

  it("hb-subset already carries the source value through unchanged", () => {
    const out = hbSubsetRetainGids(fontWithFsType(FS_TYPE_RESTRICTED), [1]);
    expect(sfntOs2FsType(out)).toBe(FS_TYPE_RESTRICTED);
  });
});

describe("embedded-font svg2ttf fallback carries the source fsType", () => {
  let dir: string;
  let restrictedPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "domotion-fstype-test-"));
    restrictedPath = join(dir, "restricted.ttf");
    writeFileSync(restrictedPath, fontWithFsType(FS_TYPE_RESTRICTED));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    clearEmbeddedFontBuilder();
    clearHintedOutlineGuardMemo();
    // The control arm forces the svg2ttf rebuild for an otherwise hinted entry.
    process.env.DOMOTION_HINTED_SUBSET = "0";
  });
  afterEach(() => {
    delete process.env.DOMOTION_HINTED_SUBSET;
  });

  it("copies the single source face's fsType instead of svg2ttf's 0", () => {
    trackGlyphInEmbedFont("fstype-restricted|w=400|s=0", 1000, 800, -200, 1, TRI, 600, {
      italic: false,
      weight: 400,
      hintedSource: { path: restrictedPath, faceIndex: 0, variationAxes: null },
    });
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({ selectedBuilder: "svg2ttf" }));
    expect(sfntOs2FsType(bytes)).toBe(FS_TYPE_RESTRICTED);
  });

  it("keeps svg2ttf's 0 when there is no single source face", () => {
    trackGlyphInEmbedFont("fstype-unknown|w=400|s=0", 1000, 800, -200, 1, TRI, 600, {
      italic: false,
      weight: 400,
      hintedSource: { path: restrictedPath, faceIndex: null, variationAxes: null },
    });
    expect(sfntOs2FsType(decodeFirstFont(getBuiltEmbeddedFontFaceCss()))).toBe(0);
  });

  it("keeps svg2ttf's 0 when the source file cannot be read", () => {
    trackGlyphInEmbedFont("fstype-missing|w=400|s=0", 1000, 800, -200, 1, TRI, 600, {
      italic: false,
      weight: 400,
      hintedSource: { path: join(dir, "missing.ttf"), faceIndex: 0, variationAxes: null },
    });
    expect(sfntOs2FsType(decodeFirstFont(getBuiltEmbeddedFontFaceCss()))).toBe(0);
  });
});

// DM-DJKYRC policy (maintainer's choice): warn, and keep embedding. A source
// face declaring Restricted License (0x0002) or bitmap-only (0x0200) embedding
// is reported once per face per generation; the embedded bytes do not change.
describe("embedding-restriction notices", () => {
  it("classifies fsType per the OpenType OS/2 usage-permission rules", () => {
    expect(embeddingRestrictionsForFsType(0x0000)).toEqual([]);
    expect(embeddingRestrictionsForFsType(0x0002)).toEqual(["restricted-license"]);
    // Pre-v3 fonts may set several usage bits; the least restrictive applies.
    expect(embeddingRestrictionsForFsType(0x0006)).toEqual([]);
    expect(embeddingRestrictionsForFsType(0x000a)).toEqual([]);
    expect(embeddingRestrictionsForFsType(0x0004)).toEqual([]);
    expect(embeddingRestrictionsForFsType(0x0008)).toEqual([]);
    expect(embeddingRestrictionsForFsType(0x0200)).toEqual(["bitmap-only"]);
    expect(embeddingRestrictionsForFsType(0x0204)).toEqual(["bitmap-only"]);
    expect(embeddingRestrictionsForFsType(0x0202)).toEqual(["restricted-license", "bitmap-only"]);
    // No-subsetting (bit 8) is outside the chosen policy.
    expect(embeddingRestrictionsForFsType(0x0100)).toEqual([]);
  });

  let dir: string;
  const fontPath = (name: string): string => join(dir, name);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "domotion-fstype-notice-"));
    writeFileSync(fontPath("restricted.ttf"), fontWithFsType(FS_TYPE_RESTRICTED));
    writeFileSync(fontPath("bitmap.ttf"), fontWithFsType(0x0200));
    writeFileSync(fontPath("installable.ttf"), fontWithFsType(0));
    writeFileSync(fontPath("preview.ttf"), fontWithFsType(0x0006));
    writeFileSync(fontPath("collection.ttc"), wrapInTtc([fontWithFsType(0), fontWithFsType(FS_TYPE_RESTRICTED)]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    clearEmbeddedFontBuilder();
    clearHintedOutlineGuardMemo();
  });

  const track = (key: string, path: string, faceIndex: number | null, postscriptName?: string): void => {
    trackGlyphInEmbedFont(key, 1000, 800, -200, 1, TRI, 600, {
      italic: false,
      weight: 400,
      hintedSource: { path, faceIndex, variationAxes: null, postscriptName },
    });
  };

  it("reports a restricted face once per generation and again after a reset", () => {
    track("r|w=400", fontPath("restricted.ttf"), 0, "Restricted-Regular");
    track("r|w=700", fontPath("restricted.ttf"), 0, "Restricted-Regular");
    const css = getBuiltEmbeddedFontFaceCss();
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([
      {
        path: fontPath("restricted.ttf"),
        faceIndex: 0,
        postscriptName: "Restricted-Regular",
        fsType: FS_TYPE_RESTRICTED,
        restrictions: ["restricted-license"],
      },
    ]);
    // A second build in the same generation (another frame) does not re-report.
    expect(getBuiltEmbeddedFontFaceCss()).toBe(css);
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([]);
    // Rendering is unchanged: the default hinted build still carries the source value.
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({ selectedBuilder: "hb-subset" }));
    expect(sfntOs2FsType(decodeFirstFont(css))).toBe(FS_TYPE_RESTRICTED);
    // A new generation reports it again.
    clearEmbeddedFontBuilder();
    track("r|w=400", fontPath("restricted.ttf"), 0, "Restricted-Regular");
    getBuiltEmbeddedFontFaceCss();
    expect(takeEmbeddedFontEmbeddingRestrictions().map((r) => (r.source === "webfont" ? null : r.faceIndex))).toEqual([
      0,
    ]);
  });

  it("produces the same CSS whether or not the notices are drained", () => {
    track("r|w=400", fontPath("restricted.ttf"), 0);
    const drained = getBuiltEmbeddedFontFaceCss();
    takeEmbeddedFontEmbeddingRestrictions();
    clearEmbeddedFontBuilder();
    track("r|w=400", fontPath("restricted.ttf"), 0);
    expect(getBuiltEmbeddedFontFaceCss()).toBe(drained);
  });

  it("ignores installable, least-restrictive, and unknown-face sources", () => {
    track("i|w=400", fontPath("installable.ttf"), 0);
    track("p|w=400", fontPath("preview.ttf"), 0);
    track("u|w=400", fontPath("restricted.ttf"), null);
    track("m|w=400", fontPath("missing.ttf"), 0);
    getBuiltEmbeddedFontFaceCss();
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([]);
  });

  it("reports bitmap-only faces, TTC members by index, and every face mixed into one entry", () => {
    // One entry whose glyphs came from two files (a per-glyph fallback).
    track("mixed|w=400", fontPath("installable.ttf"), 0);
    trackGlyphInEmbedFont("mixed|w=400", 1000, 800, -200, 2, TRI, 600, {
      italic: false,
      weight: 400,
      hintedSource: { path: fontPath("bitmap.ttf"), faceIndex: 0, variationAxes: null },
    });
    track("ttc0|w=400", fontPath("collection.ttc"), 0);
    track("ttc1|w=400", fontPath("collection.ttc"), 1);
    getBuiltEmbeddedFontFaceCss();
    expect(
      takeEmbeddedFontEmbeddingRestrictions().map((r) =>
        r.source === "webfont" ? [null] : [r.path, r.faceIndex, r.fsType, r.restrictions],
      ),
    ).toEqual([
      [fontPath("bitmap.ttf"), 0, 0x0200, ["bitmap-only"]],
      [fontPath("collection.ttc"), 1, FS_TYPE_RESTRICTED, ["restricted-license"]],
    ]);
  });

  it("reports faces from the svg2ttf control arm too", () => {
    process.env.DOMOTION_HINTED_SUBSET = "0";
    try {
      track("r|w=400", fontPath("restricted.ttf"), 0);
      getBuiltEmbeddedFontFaceCss();
      expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({ selectedBuilder: "svg2ttf" }));
      expect(takeEmbeddedFontEmbeddingRestrictions()).toHaveLength(1);
    } finally {
      delete process.env.DOMOTION_HINTED_SUBSET;
    }
  });

  it("forgets a discarded trial's face on snapshot rollback and keeps a restored one", () => {
    const marker = snapshotEmbeddedFonts();
    track("r|w=400", fontPath("restricted.ttf"), 0);
    restoreEmbeddedFonts(marker);
    getBuiltEmbeddedFontFaceCss();
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([]);
    track("r|w=400", fontPath("restricted.ttf"), 0);
    restoreEmbeddedFonts(snapshotEmbeddedFonts());
    getBuiltEmbeddedFontFaceCss();
    expect(takeEmbeddedFontEmbeddingRestrictions()).toHaveLength(1);
  });
});

// DM-N4Y9T1: a webfont is registered from its downloaded bytes and has no
// on-disk path, so it never reached the path-keyed source-face check. Its
// permission bits come from fontkit's parsed OS/2 table instead.
describe("webfont embedding-restriction notices", () => {
  const fixture = readFileSync(
    fileURLToPath(new URL("../../assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url)),
  );
  /** A registry-shaped webfont instance: the fontkit face plus its `@font-face` bytes. */
  function webfont(fsType: number): { webfontBuffer: Buffer; postscriptName?: string; familyName?: string } {
    const buffer = withOs2FsType(fixture, fsType);
    const font = fontkit.create(buffer) as unknown as {
      webfontBuffer: Buffer;
      postscriptName?: string;
      familyName?: string;
    };
    font.webfontBuffer = buffer;
    return font;
  }
  function trackWebfont(key: string, font: ReturnType<typeof webfont>): void {
    trackGlyphInEmbedFont(key, 1000, 800, -200, 1, TRI, 600, {
      italic: false,
      weight: 400,
      webfontSource: webfontEmbeddingSourceFor(font),
    });
  }

  beforeEach(() => clearEmbeddedFontBuilder());
  afterEach(() => clearEmbeddedFontBuilder());

  it("reads a webfont's permission bits from fontkit's decoded OS/2 table", () => {
    expect(webfontEmbeddingSourceFor(webfont(0x0002))).toEqual(
      expect.objectContaining({ postscriptName: "IBMPlexSerif-Regular", familyName: "IBM Plex Serif", fsType: 0x0002 }),
    );
    expect(webfontEmbeddingSourceFor(webfont(0x0304))?.fsType).toBe(0x0304);
    expect(webfontEmbeddingSourceFor(webfont(0))?.fsType).toBe(0);
    // Not a webfont: no bytes, no record.
    expect(webfontEmbeddingSourceFor({ postscriptName: "X" })).toBeNull();
    expect(webfontEmbeddingSourceFor(null)).toBeNull();
  });

  it("reports a restricted webfont once per generation, however many entries and instances use its bytes", () => {
    const font = webfont(0x0002);
    const sameBytes = fontkit.create(font.webfontBuffer) as unknown as ReturnType<typeof webfont>;
    sameBytes.webfontBuffer = font.webfontBuffer;
    trackWebfont("wf|w=400", font);
    trackWebfont("wf|w=700", sameBytes);
    getBuiltEmbeddedFontFaceCss();
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([
      {
        source: "webfont",
        postscriptName: "IBMPlexSerif-Regular",
        familyName: "IBM Plex Serif",
        fsType: 0x0002,
        restrictions: ["restricted-license"],
      },
    ]);
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([]);
    // A re-registration (a later frame's rediscovery) is a new Buffer of the same bytes: still one face.
    const reRegistered = webfont(0x0002);
    expect(reRegistered.webfontBuffer).not.toBe(font.webfontBuffer);
    trackWebfont("wf|w=400", reRegistered);
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([]);
    clearEmbeddedFontBuilder();
    trackWebfont("wf|w=400", font);
    expect(takeEmbeddedFontEmbeddingRestrictions()).toHaveLength(1);
  });

  it("ignores installable and least-restrictive webfonts, and keeps bitmap-only ones", () => {
    trackWebfont("ok|w=400", webfont(0));
    trackWebfont("print|w=400", webfont(0x0006)); // Restricted + Preview & Print: not restricted
    trackWebfont("bitmap|w=400", webfont(0x0200));
    expect(takeEmbeddedFontEmbeddingRestrictions().map((r) => [r.source, r.fsType, r.restrictions])).toEqual([
      ["webfont", 0x0200, ["bitmap-only"]],
    ]);
  });

  it("restates a single webfont's fsType in the svg2ttf rebuild instead of svg2ttf's 0", () => {
    trackWebfont("wf-bytes|w=400", webfont(0x0002));
    const bytes = decodeFirstFont(getBuiltEmbeddedFontFaceCss());
    expect(getEmbeddedFontBuildDiagnostics()[0]).toEqual(expect.objectContaining({ selectedBuilder: "svg2ttf" }));
    expect(sfntOs2FsType(bytes)).toBe(0x0002);
  });

  it("keeps svg2ttf's 0 when two webfonts with different permissions share one entry", () => {
    trackWebfont("mixed|w=400", webfont(0x0002));
    trackWebfont("mixed|w=400", webfont(0));
    expect(sfntOs2FsType(decodeFirstFont(getBuiltEmbeddedFontFaceCss()))).toBe(0);
  });

  it("forgets a discarded trial's webfont on snapshot rollback", () => {
    const marker = snapshotEmbeddedFonts();
    trackWebfont("trial|w=400", webfont(0x0002));
    restoreEmbeddedFonts(marker);
    expect(takeEmbeddedFontEmbeddingRestrictions()).toEqual([]);
  });
});
