// DM-DJKYRC: the embedded `@font-face` must not state an embedding permission
// its source face did not grant. The hb-subset path keeps the source OS/2
// table; the svg2ttf rebuild writes `fsType` 0 unless the source value is
// carried over. `fsType` is metadata only (Chromium does not read it for
// webfonts; OTS only normalizes its bits), so these tests assert the bytes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fontkit from "fontkit";
import {
  clearEmbeddedFontBuilder,
  clearHintedOutlineGuardMemo,
  getBuiltEmbeddedFontFaceCss,
  getEmbeddedFontBuildDiagnostics,
  trackGlyphInEmbedFont,
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
