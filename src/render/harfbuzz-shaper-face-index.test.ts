// Which member of a font collection HarfBuzz opens.
//
// The shaper used to open every file at face index 0. macOS ships most system
// families as `.ttc` collections whose first member is the regular cut, so any
// bold / UI / PUA face was shaped by the regular one — same glyph count, wrong
// advances, and nothing anywhere reporting an error. Measured on GeezaPro.ttc
// (member 0 GeezaPro, member 1 GeezaPro-Bold), one Arabic word came back as
// 647/1415/1292/902/900 through member 0 and 647/1676/1518/955/977 through
// member 1: both well-formed, one of them from a face nobody asked for.
//
// So these tests assert the SELECTION, not that shaping "works" — a test that
// only shaped and checked for output would have passed throughout the defect.
// The two synthetic members below differ only in their advance width, which is
// what makes the assertions discriminate: member 1's advance is a value member 0
// cannot produce.
//
// Synthetic collections rather than system fonts, for the same reason
// `font-source-honesty.test.ts` uses them: the assertions need exact knowledge
// of the member order and metrics, and must hold on every platform's CI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _clearHbFontCache, harfbuzzShapeRun, makeHarfbuzzShapingInstance } from "./harfbuzz-shaper.js";
import { buildSfnt, buildStaticHintedFont, wrapInTtc } from "./synth-test-fonts.js";
import { __resolveFaceInfoForFileForTest as faceInfo, clearFontResolutionCaches } from "./font-resolution.js";

/** "A" is a rectangle whose right edge is `aXMax`; the advance is aXMax + 50. */
const NARROW_ADVANCE = 600; // aXMax 550 (the builder's default)
const WIDE_ADVANCE = 800;   // aXMax 750

let dir: string;
/** 2-member collection: SynthNarrow (advance 600), SynthWide (advance 800). */
let ttcPath: string;
/** Single-face file, PostScript name SynthSolo, advance 600. */
let sfntPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "domotion-hb-face-"));
  ttcPath = path.join(dir, "collection.ttc");
  writeFileSync(ttcPath, wrapInTtc([
    buildStaticHintedFont({ family: "SynthNarrow" }),
    buildStaticHintedFont({ family: "SynthWide", aXMax: 750 }),
  ]));
  sfntPath = path.join(dir, "solo.ttf");
  writeFileSync(sfntPath, buildStaticHintedFont({ family: "SynthSolo" }));
  _clearHbFontCache();
  clearFontResolutionCaches();
});

afterEach(() => {
  _clearHbFontCache();
  clearFontResolutionCaches();
  rmSync(dir, { recursive: true, force: true });
});

/** Advance of the single glyph "A" shapes to, or null when shaping declined. */
function advanceAt(file: string, faceIndex: number | null): number | null {
  const res = harfbuzzShapeRun(file, faceIndex, "A");
  if (res == null) return null;
  expect(res.glyphs).toHaveLength(1);
  return res.positions[0].xAdvance;
}

describe("collection member selection", () => {
  it("shapes with the member it was asked for, not the first one", () => {
    // The regression, stated as the difference it produces. Asserting only that
    // index 1 "returns glyphs" would have passed while it silently returned
    // member 0's.
    expect(advanceAt(ttcPath, 0)).toBe(NARROW_ADVANCE);
    expect(advanceAt(ttcPath, 1)).toBe(WIDE_ADVANCE);
  });

  it("keeps members apart in the cache, whichever is asked for first", () => {
    // The face cache used to be keyed by path alone, so the first member opened
    // for a file answered for every later request against it. Both orders, since
    // a cache that returns the FIRST entry passes one order by accident.
    expect(advanceAt(ttcPath, 0)).toBe(NARROW_ADVANCE);
    expect(advanceAt(ttcPath, 1)).toBe(WIDE_ADVANCE);
    expect(advanceAt(ttcPath, 0)).toBe(NARROW_ADVANCE);

    _clearHbFontCache();
    expect(advanceAt(ttcPath, 1)).toBe(WIDE_ADVANCE);
    expect(advanceAt(ttcPath, 0)).toBe(NARROW_ADVANCE);
    expect(advanceAt(ttcPath, 1)).toBe(WIDE_ADVANCE);
  });

  it("takes index 0 for a single-face file", () => {
    expect(advanceAt(sfntPath, 0)).toBe(NARROW_ADVANCE);
  });
});

describe("refusing rather than guessing", () => {
  it("declines to shape a face it cannot identify", () => {
    // Falling back to member 0 here is the defect itself: it would shape with a
    // face the caller did not ask for and could not detect. Declining leaves the
    // caller on its own (CoreText / fontkit) shaping — a different shaper, but
    // the right font.
    expect(advanceAt(ttcPath, null)).toBeNull();
  });

  it("declines an index past the end of the collection", () => {
    // Blink's bounds check: HbFaceFromSkTypeface only creates the face when
    // `0 < num_hb_faces && ttc_index < num_hb_faces`, and returns a null face
    // otherwise so its caller falls back
    // (harfbuzz_face_from_typeface.cc:38-42, Chromium rev 7d859f27).
    expect(advanceAt(ttcPath, 2)).toBeNull();
    expect(advanceAt(ttcPath, 99)).toBeNull();
    expect(advanceAt(ttcPath, -1)).toBeNull();
  });

  it("hands back the base instance unchanged when the face is unidentified", () => {
    // The proxy's contract: `=== base` is how every call site detects "HarfBuzz
    // could not take this" and keeps its existing shaping.
    const base = { unitsPerEm: 1000 } as never;
    expect(makeHarfbuzzShapingInstance(base, ttcPath, null)).toBe(base);
    expect(makeHarfbuzzShapingInstance(base, ttcPath, 5)).toBe(base);
    expect(makeHarfbuzzShapingInstance(base, path.join(dir, "absent.ttf"), 0)).toBe(base);
  });
});

describe("end to end: the name a face was selected by reaches the shaper", () => {
  it("shapes the named member's metrics, through the resolver the callers use", () => {
    // The two halves joined: the caller resolves a PostScript name to a member
    // index, and the shaper opens that member. This is the composition the four
    // production call sites perform via `shapingFaceFor`, minus the font-key
    // registry (which would pin the test to a host's installed fonts).
    const wide = faceInfo(ttcPath, "SynthWide");
    expect(wide.faceIndex).toBe(1);
    expect(advanceAt(ttcPath, wide.faceIndex)).toBe(WIDE_ADVANCE);

    const narrow = faceInfo(ttcPath, "SynthNarrow");
    expect(narrow.faceIndex).toBe(0);
    expect(advanceAt(ttcPath, narrow.faceIndex)).toBe(NARROW_ADVANCE);
  });

  it("declines when the name is not in the file at all", () => {
    // `faceIndex: null` is the resolver's honest answer for a name it did not
    // find, and it has to stay null all the way through — a shaper that read it
    // as "unspecified, use 0" would reinstate the wrong-face bug at the seam
    // between the two.
    const absent = faceInfo(ttcPath, "SynthNotHere");
    expect(absent.faceIndex).toBeNull();
    expect(advanceAt(ttcPath, absent.faceIndex)).toBeNull();
  });
});

describe("AAT faces shape, rather than being declined", () => {
  // A `morx` table used to be disqualifying: the published harfbuzzjs is built
  // `-DHB_TINY`, which chains to `HB_NO_AAT` (`external/harfbuzz/src/hb-config.hh:44-46`,
  // `:95-96`, `:132-134`), so it could not apply `morx` at all. macOS ships
  // GeezaPro and Helvetica with `morx` and no `GSUB`, and that build returned
  // unjoined isolated forms for them — well-formed, and a different word.
  //
  // `vendor/harfbuzzjs/` is rebuilt with the configuration Chromium ships,
  // which has AAT enabled (its `README.chromium` for HarfBuzz: Chrome no longer
  // builds `hb-coretext` "as we rely on HarfBuzz' built-in AAT shaping"). So the
  // face must now be TAKEN.
  //
  // Synthetic rather than a system font, so this holds on every platform's CI.
  // The `morx` table is a dummy: real HarfBuzz decides whether to take the AAT
  // path from the table's PRESENCE (`_hb_apply_morx`, `hb-ot-shape.cc:60-65`),
  // which is exactly what the old guard keyed on, so a dummy is what
  // discriminates "guard removed" from "guard still there".
  it("takes a face carrying a morx table", () => {
    const base = buildStaticHintedFont({ family: "SynthAat" });
    const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
    const tables: Record<string, Buffer> = {};
    for (let i = 0; i < dv.getUint16(4); i++) {
      const e = 12 + i * 16;
      const tag = String.fromCharCode(...[0, 1, 2, 3].map((k) => dv.getUint8(e + k)));
      const off = dv.getUint32(e + 8), len = dv.getUint32(e + 12);
      tables[tag] = Buffer.from(base.subarray(off, off + len));
    }
    tables.morx = Buffer.alloc(16);

    const plain = path.join(dir, "plain.ttf");
    const aat = path.join(dir, "aat.ttf");
    writeFileSync(plain, base);
    writeFileSync(aat, buildSfnt(tables));

    // Both shape, and to the same advance — the dummy `morx` substitutes
    // nothing, so the only thing being asserted is that its presence no longer
    // takes the face out of HarfBuzz's hands.
    expect(advanceAt(plain, 0)).toBe(NARROW_ADVANCE);
    expect(advanceAt(aat, 0)).toBe(NARROW_ADVANCE);
  });

  // The assertion that would have failed before the vendored build, and the
  // reason it exists: a real AAT-only face, joined. Skipped off macOS, since it
  // reads a system font.
  const macOnly = process.platform === "darwin" ? it : it.skip;
  macOnly("joins Arabic through `morx` on a face with no GSUB (GeezaPro)", () => {
    // `hb-shape` 14.x, which reproduces Chrome's measured advances, gives
    // 647 656 1359 700 971 for this word. The published `-DHB_TINY` build gave
    // 647 1415 1292 902 900 — the isolated forms.
    const res = harfbuzzShapeRun("/System/Library/Fonts/GeezaPro.ttc", 0, "\u0645\u0631\u062d\u0628\u0627");
    expect(res).not.toBeNull();
    expect(res!.positions.map((p) => p.xAdvance)).toEqual([647, 656, 1359, 700, 971]);
  });
});

describe("the proxy's identity, which run grouping depends on", () => {
  // `renderTextAsPath` decides where one run ends and the next begins with
  // `useFontOverride !== curFontOverride` — an IDENTITY comparison. So when a
  // whole run routes through HarfBuzz, every codepoint in it must be handed the
  // SAME proxy object; a fresh one per call ends the run at each character and
  // feeds the shaper one-character runs. That disables contextual shaping
  // silently: output is still well-formed, just unshaped.
  //
  // Not hypothetical — the per-codepoint callers this started with never
  // noticed, because an isolated mark is its own run either way.
  const base = () => ({ unitsPerEm: 1000 }) as never;

  it("returns the same object for the same arguments", () => {
    const b = base();
    const a1 = makeHarfbuzzShapingInstance(b, sfntPath, 0, 16, null);
    const a2 = makeHarfbuzzShapingInstance(b, sfntPath, 0, 16, null);
    expect(a1).not.toBe(b);       // it did wrap
    expect(a2).toBe(a1);          // and it is the same wrapper
  });

  it("does not share a proxy across arguments that shape differently", () => {
    // The memo key has to include everything that changes the output, or two
    // runs at different sizes or axis locations would silently share one.
    const b = base();
    const at16 = makeHarfbuzzShapingInstance(b, sfntPath, 0, 16, null);
    expect(makeHarfbuzzShapingInstance(b, sfntPath, 0, 32, null)).not.toBe(at16);
    expect(makeHarfbuzzShapingInstance(b, sfntPath, 0, 16, { wght: 700 })).not.toBe(at16);
    expect(makeHarfbuzzShapingInstance(b, ttcPath, 1, 16, null)).not.toBe(at16);
    // …and re-asking for the original still returns the original.
    expect(makeHarfbuzzShapingInstance(b, sfntPath, 0, 16, null)).toBe(at16);
  });

  it("keeps different base instances apart", () => {
    // Two fonts wrapping the same file must not collapse into one proxy — the
    // proxy forwards metrics and coverage to ITS base.
    const b1 = base(), b2 = base();
    expect(makeHarfbuzzShapingInstance(b1, sfntPath, 0, 16, null))
      .not.toBe(makeHarfbuzzShapingInstance(b2, sfntPath, 0, 16, null));
  });
});
