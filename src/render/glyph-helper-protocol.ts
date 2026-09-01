/**
 * Typed JSON envelope shared by every native glyph-helper transport.
 *
 * Platform helpers may omit optional fields when an older binary is in use;
 * callers keep the existing fail-closed behavior for those responses.
 */

import type { GlyphResponse, MetaResponse } from "./glyph-helper-outline.js";

/** One request envelope may open fonts and batch heterogeneous queries. */
export interface HelperRequest {
  fonts: Array<{
    ref: string;
    postscriptName?: string;
    fontPath?: string;
    fontData?: string;
    size: number;
    variations?: Record<string, number>;
    requestScoped?: boolean;
    /** macOS `MatchSystemUIFont` route rather than named-face opening. */
    systemUI?: boolean;
    cssWeight?: number;
    cssSlant?: number;
    cssWidth?: number;
    italic?: boolean;
  }>;
  queries: Array<
    | { type: "meta"; fontRef: string }
    | { type: "glyphs"; fontRef: string; glyphs: Array<{ cp?: number; id?: number }> }
    // Linux-only target-strike outline used by the DM-2623 embedded-font
    // terminal-mask correction. Coordinates are FreeType 26.6 pixels, y-up.
    // Older helpers answer "unknown query type" and the caller falls back.
    | {
        type: "hintedGlyphs"; fontRef: string; fontSizePx: number;
        hintStyle: "none" | "slight" | "normal" | "full";
        forceAutoHint: boolean; useBitmaps: boolean;
        glyphs: Array<{ cp?: number; id?: number }>;
      }
    // `cssWeight` / `bold` / `italic` drive the in-family re-selection the macOS
    // helper performs after the cascade walk (Blink's
    // `GetAlternateFontPlatformData`). Absent → the nominated face stands.
    // `baseFamilyName` / `locale` are the win32 helper's two remaining
    // `MapCharacters` arguments (DM-1871 / DM-1896); the macOS and Linux helpers
    // ignore both.
    | {
        type: "fallback"; fontRef: string; cps: number[];
        cssWeight?: number; bold?: boolean; italic?: boolean;
        baseFamilyName?: string; locale?: string; monoEmoji?: boolean;
      }
    // DM-1878: the style fields pick the CUT within the family — on Windows
    // `GetFirstMatchingFont(weight, stretch, style)`, i.e. what
    // `matchFamilyStyle(name, font_description.SkiaFontStyle())` bottoms out in.
    // Absent → DirectWrite's default face, which is what Blink's presence probe
    // `matchFamilyStyle(name, SkFontStyle())` asks for, so omitting them is the
    // correct transcription for a presence check rather than just a fallback.
    | {
        type: "family"; name: string;
        cssWeight?: number; italic?: boolean; cssSlant?: number; cssStretch?: number;
      }
    // macOS declared-family style match — Blink's `BestStyleMatchForFamilyNS`
    // over `NSFontManager.availableMembersOfFontFamily`, compared with
    // `BetterChoiceCT` (nearest CSS weight, bold in the trait-precedence loop;
    // `platform/fonts/mac/font_matcher_mac.mm:172-277` at Chromium tag
    // 147.0.7727.15, the build Playwright pins). This is the step that picks
    // WHICH CUT of a declared family a run opens; the `family` query above is
    // name resolution and does not run it.
    | { type: "familyMatch"; family: string; cssWeight?: number; italic?: boolean; bold?: boolean;
        /** CSS `font-stretch` as a percentage (100 = `normal`). The helper turns
         *  it into the condensed / expanded symbolic trait the way Blink's
         *  `ComputeDesiredTraits` does. Absent = 100, i.e. the previous behavior. */
        cssWidth?: number }
    | { type: "shape"; fontRef: string; text: string }
    // DM-1886 (Linux): per-codepoint fallback via fontconfig sort-and-walk.
    | { type: "fcfallback"; lang: string; cps: number[] }
    | { type: "fcdiagnostic"; lang: string; cps: number[] }
    | { type: "systemfont" }
  >;
}
// DM-1028: one shaped glyph from the CoreText `shape` query. Coordinates are
// in font design units, y-up. `cluster` is the UTF-16 source index in the
// shaped text; `ax`/`ay` are the glyph advance and `dx`/`dy` the GPOS offset
// from the glyph's pen origin. `d` is the outline (drawn from the run's own
// CoreText font, so a sub-substitution still draws the right glyph).
export interface ShapeResponseGlyph {
  id: number;
  cluster: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  d: string;
}
export interface FallbackResponseEntry {
  cp: number;
  found: boolean;
  postscriptName?: string;
  familyName?: string;
  path?: string;
  /** DM-1721 (win32 helper ≥0.2.0): when the mapped face is a variable-font
   *  instance, the axis location DirectWrite resolved it to (e.g.
   *  `{wght: 400, opsz: 10.5}` for "Segoe UI Variable Text" — DirectWrite pins
   *  named optical subfamilies at a fixed opsz at every font size). Absent for
   *  static faces, the macOS/Linux helpers, and older win32 binaries. */
  axes?: Record<string, number>;
  /** macOS only: the substituted CTFont handle's variation axes (CT order) with
   *  the handle's CURRENT position (`value` = CTFontCopyVariation overlay the
   *  axis default). Blink clones the substituted typeface at `opsz` = the CSS
   *  specified size only when that differs from this current position
   *  (`VariableAxisChangeEffective`), and CoreText pre-sets `opsz` on SOME
   *  substituted handles — so whether Chrome renames the face with baked-in
   *  coordinates is a property of the handle, only observable here. Absent for
   *  static faces and older helper binaries. */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
  /** Whether the reported face actually has a glyph for `cp`, decided inside the
   *  helper where the font is already open. The caller needs this — Blink's
   *  fallback iterator only uses a stage's font when it has a glyph — and until
   *  the helper answered it, the caller asked in a SECOND round trip.
   *
   *  It cannot be inferred from `found`: `CTFontCreateForString` does return a
   *  face that renders the string, but the in-family re-selection Blink runs on
   *  the nomination replaces it with a different cut at the requested traits,
   *  and that cut need not carry the character.
   *
   *  Absent on older helper binaries, which is why the caller keeps its probe as
   *  a fallback rather than treating a missing field as "not covered". */
  covered?: boolean;
}
export interface FamilyResponse {
  type: "family";
  found: boolean;
  postscriptName?: string;
  familyName?: string;
  path?: string;
  /** DM-1721: resolved axis values of a variable-face match (win32 ≥0.2.0). */
  axes?: Record<string, number>;
  /** macOS only (helper ≥ the build carrying the family-query axis report):
   *  the resolved CTFont handle's variation axes with its CURRENT position —
   *  same encoding as `FallbackResponseEntry.ctAxes`. For a variable family
   *  this identifies the FACE the name denotes: CoreText resolves AppKit
   *  member / named-instance / clone names ("Skia-Regular_Light") to a handle
   *  whose variation is already at that instance's coordinates. Absent for
   *  static faces and older binaries. */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
}
export interface FamilyMatchResponse {
  type: "familyMatch";
  found: boolean;
  /** The chosen family member's PostScript name. */
  postscriptName?: string;
  /** The chosen member's CSS weight, as the matcher scored it. */
  weight?: number;
  /** Every family member the matcher scanned, in enumeration order. */
  candidates?: Array<{
    name: string; weight: number; descriptorWeight: number;
    /** `CTFontSymbolicTraits` masked to italic / bold / condensed / expanded. */
    traits: number; appKitWeight: number; appKitTraits: number;
  }>;
  // Linux helper only (the fontconfig transcription of Skia's
  // `SkFontConfigInterfaceDirect::matchFamilyName`): the resolved file, its
  // TTC member index, the matched family, and the matched face's style as
  // Skia would report `outStyle` — Blink consults that for synthetic bold /
  // italic, so the Node side needs the same numbers.
  path?: string;
  index?: number;
  family?: string;
  width?: number;
  italic?: boolean;
}
export interface HelperResponse {
  results: Array<
    | (MetaResponse & { type: "meta" })
    | { type: "glyphs"; glyphs: GlyphResponse[] }
    | { type: "hintedGlyphs"; fontSizePx?: number; coordinateScale?: number; glyphs?: GlyphResponse[]; error?: string }
    | { type: "fallback"; fonts: FallbackResponseEntry[] }
    | FamilyResponse
    | FamilyMatchResponse
    | { type: "shape"; glyphs?: ShapeResponseGlyph[]; error?: string }
    | {
        type: "fcfallback";
        fonts?: Array<{
          cp: number; found: boolean; path?: string; index?: number;
          isBold?: boolean; isItalic?: boolean; family?: string;
        }>;
        error?: string;
      }
    | {
        type: "fcdiagnostic"; before: string; after: string; fingerprint: string;
        candidates?: Array<{
          rank: number; path: string; index: number; family?: string;
          postscriptName?: string; covers: number[];
        }>;
        error?: string;
      }
    | { type: "systemfont"; found?: boolean; family?: string; error?: string }
  >;
}
