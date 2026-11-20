import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedPseudoFragmentSet } from "./types.js";
import { capturedElement, capturedSegment, type DeepPartial } from "../test-support/captured-fixtures.js";

/**
 * Bitmap-glyph raster spans are decided during capture by the same run splitter
 * glyph emission uses, so they must select with the same language:
 * `fontSelectionLanguage` (explicit computed locale, then the authenticated
 * renderer default for `auto`, then DOM language). Before DM-XWGRJC the element
 * path passed DOM language and the pseudo path ran before the default locale was
 * recorded on its typography.
 */
const calls: Array<string | undefined> = [];
vi.mock("../render/text-to-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../render/text-to-path.js")>();
  return {
    ...actual,
    selectedGlyphRasterSpans: (_text: string, _spans: unknown, options: { lang?: string }) => {
      calls.push(options.lang);
      return [];
    },
  };
});

const { selectedRasterSpansForSegment } = await import("./emoji.js");
const { pseudoBitmapRepresentations } = await import("./pseudo-fragment-cdp.js");

beforeEach(() => {
  calls.length = 0;
});

const element = (styles: { fontLocale?: string; defaultFontLocale?: string; lang?: string }) =>
  capturedElement({ styles: { fontFamily: "Times", fontSize: "32px", fontWeight: "400", ...styles } });
const segment = capturedSegment({ text: "☀ 漢" });
const spans = [{ start: 0, end: 1 }];

describe("element raster spans select with fontSelectionLanguage (DM-XWGRJC)", () => {
  it.each([
    {
      name: "auto uses the renderer default",
      styles: { fontLocale: "auto", defaultFontLocale: "ja", lang: "en" },
      lang: "ja",
    },
    { name: "explicit locale wins over DOM language", styles: { fontLocale: '"zh-TW"', lang: "ja" }, lang: "zh-TW" },
    { name: "an empty explicit locale stays empty", styles: { fontLocale: '""', lang: "ja" }, lang: "" },
    { name: "unauthenticated auto keeps DOM language", styles: { fontLocale: "auto", lang: "ko" }, lang: "ko" },
    { name: "old captures keep DOM language", styles: { lang: "ko" }, lang: "ko" },
  ])("$name", ({ styles, lang }) => {
    selectedRasterSpansForSegment(element(styles), segment, spans);
    expect(calls).toEqual([lang]);
  });
});

const pseudo = (typography: DeepPartial<CapturedPseudoFragmentSet["typography"]>) =>
  ({
    status: "exact",
    contentItems: [],
    fragments: [{ kind: "text", text: "☀" }],
    typography: { fontFamily: "Times", paintFontSize: 32, fontWeight: "400", fontStyle: "normal", ...typography },
  }) as unknown as CapturedPseudoFragmentSet;

describe("pseudo raster spans select with the renderer default before annotation (DM-XWGRJC)", () => {
  it("uses the capture's default locale for an auto pseudo", () => {
    pseudoBitmapRepresentations(pseudo({ fontLocale: "auto", language: "en" }), "ja");
    expect(calls).toEqual(["ja"]);
  });
  it("keeps an explicit pseudo locale", () => {
    pseudoBitmapRepresentations(pseudo({ fontLocale: '"ko"', language: "en" }), "ja");
    expect(calls).toEqual(["ko"]);
  });
  it("keeps DOM language without an authenticated default", () => {
    pseudoBitmapRepresentations(pseudo({ fontLocale: "auto", language: "en" }), undefined);
    expect(calls).toEqual(["en"]);
  });
});
