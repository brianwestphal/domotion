import { describe, expect, it } from "vitest";
import {
  authenticatedImageFonts,
  imageFontDigest,
  imageOwnFontSheets,
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
