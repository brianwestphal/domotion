import { describe, expect, it } from "vitest";
import {
  authenticatedImageFonts,
  imageFontDigest,
  imageOwnFontSheets,
  rewriteImageFontFaces,
  type ImageOwnFontContext,
} from "./svg-image-own-fonts.js";

describe("image-owned font evidence", () => {
  it.each(['media="not all"', 'title="alternate"', 'type="text/plain"'])(
    "refuses unproven active style set %s",
    (attrs) => {
      expect(
        imageOwnFontSheets(
          `<svg><style ${attrs}>@font-face{font-family:A;src:url(data:font/ttf;base64,AA==)}</style></svg>`,
        ),
      ).toBeNull();
    },
  );
  it("decodes XML entities before CSS and safely splits CDATA terminators", () => {
    const source = `<svg><style>@font-face{font-family:'A &amp; B';src:url(data:font/ttf;base64,AA==)}.x{content:']]&gt;'}</style></svg>`;
    const sheets = imageOwnFontSheets(source);
    expect(sheets?.faces[0]).toContain("A & B");
    expect(sheets?.source).toContain("]]]]><![CDATA[>");
    expect(imageOwnFontSheets(sheets!.source)?.faces).toEqual(sheets?.faces);
  });
  it.each(["@media screen", "@supports (display:grid)", "@scope (.x)", "@layer fonts"])(
    "rejects unproven conditional face availability: %s",
    (group) => {
      expect(
        imageOwnFontSheets(
          `<svg><style>${group}{@font-face{font-family:A;src:url(data:font/ttf;base64,AA==)}}</style></svg>`,
        ),
      ).toBeNull();
    },
  );
  it("requires source and normalized byte digests independently", () => {
    const source = "<svg/>";
    const data = Buffer.from("font-data");
    const context: ImageOwnFontContext = {
      authority: "chromium-svg-image-fonts-v1",
      sourceSha256: imageFontDigest(source),
      faces: [
        {
          family: "A",
          weight: "400",
          style: "normal",
          stretch: "normal",
          unicodeRange: [[0, 0x10ffff]],
          data: data.toString("base64"),
          sha256: imageFontDigest(data),
        },
      ],
    };
    expect(authenticatedImageFonts(source, context)?.[0].data).toEqual(data);
    expect(authenticatedImageFonts("<svg />", context)).toBeNull();
    context.faces[0].data = Buffer.from("changed").toString("base64");
    expect(authenticatedImageFonts(source, context)).toBeNull();
    expect(authenticatedImageFonts(source)).toBeNull();
  });
});

describe("rewriteImageFontFaces", () => {
  it("edits faces in imageOwnFontSheets order and refuses a source it rejects", () => {
    const source = `<svg><style>@font-face{font-family:A;src:url(data:a)} .x{fill:red} @font-face{font-family:B;src:url(data:b)}</style></svg>`;
    const seen: string[] = [];
    const out = rewriteImageFontFaces(source, (index, rule) => {
      seen.push(`${index}:${rule.toString()}`);
      return index === 0 ? null : "@font-face{font-family:C;src:url(data:c)}";
    });
    expect(seen).toEqual([
      "0:@font-face{font-family:A;src:url(data:a)}",
      "1:@font-face{font-family:B;src:url(data:b)}",
    ]);
    expect(out).not.toContain("font-family:A");
    expect(out).toContain("font-family:C");
    expect(out).toContain(".x{fill:red}");
    expect(
      rewriteImageFontFaces(`<svg><style media="print">@font-face{font-family:A}</style></svg>`, () => null),
    ).toBeNull();
  });
  it("rejects negative or non-finite metric descriptors in evidence", () => {
    const data = Buffer.from("font-data");
    const context: ImageOwnFontContext = {
      authority: "chromium-svg-image-fonts-v1",
      sourceSha256: imageFontDigest("<svg/>"),
      faces: [
        {
          family: "A",
          unicodeRange: [[0, 0x10ffff]],
          data: data.toString("base64"),
          sha256: imageFontDigest(data),
          sizeAdjust: 1.5,
        },
      ],
    };
    expect(authenticatedImageFonts("<svg/>", context)?.[0].sizeAdjust).toBe(1.5);
    context.faces[0].ascentOverride = -0.1;
    expect(authenticatedImageFonts("<svg/>", context)).toBeNull();
  });
});
