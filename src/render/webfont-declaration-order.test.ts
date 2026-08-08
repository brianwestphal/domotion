// Webfont tie-break direction: within one capabilities group Blink appends a
// segmented family's faces in REVERSE declaration order
// (`font_faces_->ForEachReverse`, `core/css/css_segmented_font_face.cc:125-136`,
// rev 7d859f27) and `SegmentedFontData::FontDataForCharacter` takes the FIRST
// appended face that covers the character
// (`platform/fonts/segmented_font_data.cc:33-40`) — so among equally-scored
// faces the LAST-declared wins, the CSS Fonts rule that later `@font-face`
// declarations override earlier ones. Our pickers used a strict `<` over
// registration order, which made the FIRST-registered face win instead.
//
// The Domotion-specific scalar-weight tie-break (WEBFONT_WEIGHT_TIEBREAK_SCALE)
// is a capture-inference necessity for the CSS-less resource-discovery path
// only — faces registered with NO font-weight descriptor. It must not reach
// declared descriptors, where Blink's WeightDistance is the entire rule and
// exact ties fall to declaration order.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  registerWebfont, clearWebfonts,
  __pickWebfontVariantMetaForTest, __pickWebfontVariantMetaForCodepointForTest,
} from "./font-resolution.js";

// A real parseable font buffer — which font it is doesn't matter for
// SELECTION tests, only the declared descriptors do (same approach as
// webfont-weight-descriptor.test.ts).
const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";
const LIBERATION = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";
const FONT_FILE = existsSync(HELVETICA) ? HELVETICA : (existsSync(LIBERATION) ? LIBERATION : null);
const fontBuf = FONT_FILE != null ? readFileSync(FONT_FILE) : null;
const describeWithFont = fontBuf != null ? describe : describe.skip;

// Distinct-but-equivalent unicode-ranges covering 'A' (the Latin probe) and
// U+00E9, used purely as markers to tell two otherwise identically-scoring
// variants apart in the picker's answer.
const MARK_FIRST: Array<[number, number]> = [[0x0000, 0xFFFF]];
const MARK_LAST: Array<[number, number]> = [[0x0000, 0xFFFD]];

describeWithFont("last-declared wins on exact score ties (Blink's reverse-declaration order)", () => {
  beforeEach(() => clearWebfonts());

  it("two faces with identical declared capabilities: the later declaration overrides", () => {
    registerWebfont("dup", 400, "normal", fontBuf!, MARK_FIRST, undefined, "400");
    registerWebfont("dup", 400, "normal", fontBuf!, MARK_LAST, undefined, "400");
    expect(__pickWebfontVariantMetaForTest("dup", 400, false)?.unicodeRange).toEqual(MARK_LAST);
  });

  it("per-codepoint pick honors the same rule when both ranges cover the codepoint", () => {
    registerWebfont("dupcp", 400, "normal", fontBuf!, MARK_FIRST, undefined, "400");
    registerWebfont("dupcp", 400, "normal", fontBuf!, MARK_LAST, undefined, "400");
    expect(__pickWebfontVariantMetaForCodepointForTest("dupcp", 400, false, 0x00E9)?.unicodeRange).toEqual(MARK_LAST);
  });
});

describeWithFont("the scalar tie-break is confined to descriptor-less (resource-discovered) faces", () => {
  beforeEach(() => clearWebfonts());

  it("declared descriptors tie on WeightDistance alone — the legacy scalar must not reorder them", () => {
    // Both faces cover the request at distance 0: `400` exactly, `100 900` as
    // a containing range. Blink has NO further weight preference between
    // them — the last-declared face wins. The old behavior let the legacy
    // scalar (|Δweight|·1e-4) pick the single-weight face regardless of
    // declaration order.
    registerWebfont("vf", 400, "normal", fontBuf!, undefined, undefined, "400");
    registerWebfont("vf", 100, "normal", fontBuf!, undefined, undefined, "100 900");
    expect(__pickWebfontVariantMetaForTest("vf", 400, false)?.weightCaps).toEqual([100, 900]);
  });

  it("resource-discovered faces (no descriptor) still separate by their OS/2 scalar weight", () => {
    // Regression guard for the capture-inference path: every face selects as
    // [400, 400], so only the scalar can route a bold run to the bold buffer.
    // Register the bold face FIRST so declaration order alone cannot explain
    // the answer.
    registerWebfont("res", 700, "normal", fontBuf!);
    registerWebfont("res", 400, "normal", fontBuf!);
    expect(__pickWebfontVariantMetaForTest("res", 700, false)?.weight).toBe(700);
    expect(__pickWebfontVariantMetaForTest("res", 400, false)?.weight).toBe(400);
  });
});
