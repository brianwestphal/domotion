// The Linux helper-less family-identity acceptance is Skia's own rule,
// transcribed from the DEPS-pinned revision the pinned Chrome builds with:
// `MatchFont` (`62efacd3:src/ports/SkFontConfigInterface_direct.cpp:553-590`)
// accepts fontconfig's pick iff one of the pick's family names strcasecmp-
// equals the post-config-substitution request family or the requested family,
// or the requested and matched names share a `kFontEquivMap`
// metric-equivalence class (`GetFontEquivClass` `:190-325`,
// `IsMetricCompatibleReplacement` `:330-336`).
//
// The rule it replaced — strip `[-_ ]` and a trailing
// `regular|mt|psmt|ps|roman|book`, then compare — has no upstream analogue and
// failed in both directions; the cases below that carry a "previously:" note
// are the discriminating ones (they fail against the canonicalization rule).
import { describe, expect, it } from "vitest";
import { skiaFamilyMatchAcceptable } from "./font-resolution.js";

describe("skiaFamilyMatchAcceptable (pinned-Skia MatchFont transcription)", () => {
  it("accepts an exact match, ASCII-case-insensitively (strcasecmp)", () => {
    expect(skiaFamilyMatchAcceptable("Arial", "Arial", ["ARIAL"])).toBe(true);
    expect(skiaFamilyMatchAcceptable("dejavu sans", "dejavu sans", ["DejaVu Sans"])).toBe(true);
  });

  it("accepts a metric-equivalence-class replacement", () => {
    // The Liberation-only host: fontconfig answers Liberation Serif for
    // "Times New Roman"; SERIF class accepts. Previously: REJECTED (canon
    // "timesnewroman" != "liberationserif") — Chrome painted the family and
    // we walked past it.
    expect(skiaFamilyMatchAcceptable("Times New Roman", "Times New Roman", ["Liberation Serif"])).toBe(true);
    expect(skiaFamilyMatchAcceptable("Arial", "Arial", ["Arimo"])).toBe(true);
    expect(skiaFamilyMatchAcceptable("Courier New", "Courier New", ["Cousine"])).toBe(true);
    expect(skiaFamilyMatchAcceptable("Cambria", "Cambria", ["Caladea"])).toBe(true);
  });

  it("rejects a suffix-cousin name — no canonicalization upstream", () => {
    // Previously: ACCEPTED (canon strips the "MT" / "Book" tail), painting a
    // family Chrome rejects.
    expect(skiaFamilyMatchAcceptable("Arial MT", "Arial MT", ["Arial"])).toBe(false);
    expect(skiaFamilyMatchAcceptable("Helvetica Book", "Helvetica Book", ["Helvetica"])).toBe(false);
    expect(skiaFamilyMatchAcceptable("Times Roman", "Times Roman", ["Times"])).toBe(false);
  });

  it("rejects a substitute outside every class", () => {
    // fontconfig's default for a miss: an unrelated face. Both rules reject
    // this one; it pins the everyday direction.
    expect(skiaFamilyMatchAcceptable("Monaco", "Monaco", ["Times New Roman"])).toBe(false);
    expect(skiaFamilyMatchAcceptable("Menlo", "Menlo", ["DejaVu Sans"])).toBe(false);
  });

  it("accepts through the post-config-substitution family (a distro alias)", () => {
    // Skia's first clause: an `Arial` → `Liberation Sans` preference in the
    // fontconfig config rewrites the pattern before matching, so the pick
    // equals the post-config name (`:640-645`'s worked example).
    expect(skiaFamilyMatchAcceptable("SomeAliasedName", "Liberation Sans", ["Liberation Sans"])).toBe(true);
  });

  it("accepts when ANY of the pick's family names matches (the Issue-12530 clause)", () => {
    // `:575-580`: requested "Bitstream Vera Sans", post-config "Arial", match
    // families include the requested name — a good match.
    expect(skiaFamilyMatchAcceptable("Bitstream Vera Sans", "Arial",
      ["Bitstream Vera Sans", "Roman"])).toBe(true);
  });

  it("honors kFontEquivMap's first-match class for names listed twice", () => {
    // "Noto Serif CJK JP" appears under PMINCHO first and MINCHO second;
    // `GetFontEquivClass` returns the first hit, so it is compatible with
    // MS PMincho and NOT with MS Mincho — asymmetric, exactly as upstream.
    expect(skiaFamilyMatchAcceptable("MS PMincho", "MS PMincho", ["Noto Serif CJK JP"])).toBe(true);
    expect(skiaFamilyMatchAcceptable("MS Mincho", "MS Mincho", ["Noto Serif CJK JP"])).toBe(false);
    // ...while the class's own single-listed members still pair up.
    expect(skiaFamilyMatchAcceptable("MS Mincho", "MS Mincho", ["IPAMincho"])).toBe(true);
  });
});
