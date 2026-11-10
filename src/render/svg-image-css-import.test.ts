import { describe, expect, it } from "vitest";
import { resolveSvgImageCssImports } from "./svg-image-css-import.js";

describe("resolveSvgImageCssImports", () => {
  it("leaves a data-imported external resource for image raster fallback", () => {
    const css = `rect { fill: url(https://example.test/paint.svg) }`;
    const svg = `<svg><style>@import url("data:text/css,${encodeURIComponent(css)}");</style><rect/></svg>`;
    expect(resolveSvgImageCssImports(svg)).toBeNull();
  });

  it("drops a late import that Blink ignores in the SVG image", () => {
    const svg = `<svg><style>rect { fill: green } @import url("data:text/css,rect%7Bfill%3Ared%7D");</style><rect/></svg>`;
    expect(resolveSvgImageCssImports(svg)).toBe(`<svg><style>rect { fill: green }</style><rect/></svg>`);
  });

  it("classifies the decoded escaped import scheme before expansion", () => {
    const svg = `<svg><style>@import url("data\\3a text/css,rect%7Bfill%3Ared%7D");</style><rect/></svg>`;
    expect(resolveSvgImageCssImports(svg)).toContain("rect{fill:red}");
  });
});

const dataUrl = (bytes: Buffer, head = "text/css"): string => `data:${head};base64,${bytes.toString("base64")}`;
const image = (url: string, cdata = false): string => {
  const css = `@import url("${url}");`;
  return `<svg><style>${cdata ? `<![CDATA[${css}]]>` : css}</style><rect/></svg>`;
};

describe("safe byte and XML expansion (DM-6ZX6W0)", () => {
  it.each(["windows-1252", "iso-8859-1"])("decodes %s bytes without UTF-8 loss", (charset) => {
    const svg = image(dataUrl(Buffer.from('[id="é"]{fill:red}', "latin1"), `text/css;charset=${charset}`));
    expect(resolveSvgImageCssImports(svg)).toContain('[id="é"]{fill:red}');
  });
  it.each(["utf-16le", "utf-16be"])("decodes %s at the byte boundary", (charset) => {
    const bytes = Buffer.from('rect{font-family:"é"}', "utf16le");
    expect(
      resolveSvgImageCssImports(
        image(dataUrl(charset === "utf-16be" ? bytes.swap16() : bytes, `text/css;charset=${charset}`)),
      ),
    ).toContain('font-family:"é"');
  });
  it("uses BOM before transport charset, then in-band charset before inherited encoding", () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[id="é"]{fill:red}')]);
    expect(resolveSvgImageCssImports(image(dataUrl(utf8, "text/css;charset=windows-1252")))).toContain('[id="é"]');
    expect(
      resolveSvgImageCssImports(image(dataUrl(Buffer.from('@charset "windows-1252";[id="é"]{fill:red}', "latin1")))),
    ).toContain('[id="é"]');
    const nested = "data:text/css,%5Bid%3D%22%E9%22%5D%7Bfill%3Ared%7D";
    expect(
      resolveSvgImageCssImports(image(dataUrl(Buffer.from(`@import "${nested}";`), "text/css;charset=windows-1252"))),
    ).toContain('[id="é"]');
  });
  it("percent-decodes bytes before forgiving base64 and retains raw encoded percent bytes", () => {
    const encoded = Buffer.from("rect{fill:red}").toString("base64").replace(/=/g, "%3D");
    expect(resolveSvgImageCssImports(image(`data:text/css;base64,${encoded}`))).toContain("rect{fill:red}");
    expect(
      resolveSvgImageCssImports(image("data:text/css;charset=windows-1252,%5Bid%3D%22%E9%22%5D%7Bfill%3Ared%7D")),
    ).toContain('[id="é"]');
  });
  it("expands CDATA and XML-sensitive selectors without interpreting CSS text as XML", () => {
    const css = '[data-x="<&"]{fill:red}/* <& */';
    const out = resolveSvgImageCssImports(image(dataUrl(Buffer.from(css)), true));
    expect(out).toContain(`<![CDATA[${css}]]>`);
    const withEntity = `<svg><style>@import &quot;data:text/css,rect%7Bfill%3Ared%7D&quot;;</style></svg>`;
    expect(resolveSvgImageCssImports(withEntity)).toBe("<svg><style>rect{fill:red}</style></svg>");
  });
  it("splits CDATA terminators without changing CSS text", () => {
    expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from('rect{--x:"]]>";fill:red}'))))).toContain(
      "]]]]><![CDATA[>",
    );
  });
  it("uses the first nonempty charset and canonicalizes URL whitespace", () => {
    expect(
      resolveSvgImageCssImports(
        image(dataUrl(Buffer.from('[id="é"]{fill:red}', "latin1"), "text/css;charset=;charset=windows-1252")),
      ),
    ).toContain('[id="é"]');
    expect(resolveSvgImageCssImports(image(" data:text/css,rect%7Bfill%3Ared%7D "))).toContain("rect{fill:red}");
  });
  it("accepts native unknown-content CSS MIME and drops blocked MIME sheets", () => {
    expect(
      resolveSvgImageCssImports(image(dataUrl(Buffer.from("rect{fill:red}"), "application/x-unknown-content-type"))),
    ).toContain("rect{fill:red}");
    for (const mime of ["text/plain", "application/css", "application/octet-stream", ""]) {
      expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from("rect{fill:red}"), mime)))).toBe(
        "<svg><style></style><rect/></svg>",
      );
    }
  });
  it("keeps layer reservation for rejected sheets inside the import conditions", () => {
    const svg = '<svg><style>@import "data:text/plain," layer(first) not all;</style></svg>';
    expect(resolveSvgImageCssImports(svg)).toContain("@media not all { @layer first {  } }");
  });
  it("validates every charset parameter before selecting the first nonempty label", () => {
    const bytes = Buffer.from("rect{fill:red}");
    expect(resolveSvgImageCssImports(image(dataUrl(bytes, "text/css;charset=;charset=utf-8")))).toContain(
      "rect{fill:red}",
    );
    for (const label of ["bad:value", "bad value"])
      expect(resolveSvgImageCssImports(image(dataUrl(bytes, `text/css;charset=utf-8;charset=${label}`)))).toBeNull();
    const quoted = dataUrl(bytes, 'text/css;charset=utf-8;charset="bad:value"');
    expect(resolveSvgImageCssImports(`<svg><style>@import '${quoted}';</style><rect/></svg>`)).toBeNull();
  });
  it("admits independent canonical data resources and ignores URL-like strings", () => {
    for (const css of [
      '@font-face{font-family:X;src:url("data:font/woff2;base64,AA==")}',
      'rect{--label:"url(https://host.test)";fill:red}',
    ])
      expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from(css))))).not.toBeNull();
  });
  it.each([
    "rect{fill:url(#local)}",
    "rect{fill:url(relative.svg#p)}",
    "rect{fill:url(https://host.test/x)}",
    "rect{fill:u\\72l(https://host.test/x)}",
    'rect{background:image-set("https://host.test/x" 1x)}',
    'rect{background:url("data:image/svg+xml,<svg/>")}',
  ])("retains raster for dependent or ambiguous resource values: %s", (css) => {
    expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from(css))))).toBeNull();
  });
  it.each(['rect{--x:"</style>"}'])("preserves representable closing-style data: %s", (css) => {
    expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from(css))))).not.toBeNull();
  });
  it("rejects malformed decoding, escaped import keywords and byte/depth overflow", () => {
    expect(resolveSvgImageCssImports(image("data:text/css;base64,@@@"))).toBeNull();
    expect(resolveSvgImageCssImports(image("data:text/css;base64;x=y,rect{fill:red}"))).toBeNull();
    expect(resolveSvgImageCssImports(image("data:text/css,%E9"))).toBeNull();
    expect(resolveSvgImageCssImports(image("data:text/css;charset=not-an-encoding,rect%7Bfill%3Ared%7D"))).toBeNull();
    expect(resolveSvgImageCssImports(image("data:text/css;charset=shift_jis,rect%7Bfill%3Ared%7D"))).toBeNull();
    expect(resolveSvgImageCssImports('<svg><style>@\\69mport "https://host.test/x";</style></svg>')).toBe(
      "<svg><style></style></svg>",
    );
    expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from("/*" + "é".repeat(128_000) + "*/"))))).toBeNull();
    expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from("/*" + "]]>".repeat(30_000) + "*/"))))).toBeNull();
    let css = "rect{fill:red}";
    for (let i = 0; i < 5; i++) css = `@import "${dataUrl(Buffer.from(css))}";`;
    expect(resolveSvgImageCssImports(`<svg><style>${css}</style></svg>`)).toBeNull();
  });
});

it("detects entity-hidden and nested escaped imports without changing unrelated escapes", () => {
  expect(
    resolveSvgImageCssImports('<svg><style>&#64;import "data:text/css,rect%7Bfill%3Ared%7D";</style></svg>'),
  ).toContain("rect{fill:red}");
  const escaped = '@\\69 mport "https://host.test/x";';
  expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from(escaped))))).toBe("<svg><style></style><rect/></svg>");
  const unrelated = "<svg><style>@f\\6f nt-face{font-family:X}</style></svg>";
  expect(resolveSvgImageCssImports(unrelated)).toBe(unrelated);
});

it("keeps author-font metrics out of the isolated system-font transform resolver", () => {
  const font = "@font-face{font-family:X;src:url(data:font/woff2;base64,AA==)}";
  expect(
    resolveSvgImageCssImports(image(dataUrl(Buffer.from(font + "svg{font:20px X;transform:translateX(2ch)}")))),
  ).toBeNull();
  expect(resolveSvgImageCssImports(image(dataUrl(Buffer.from(font + "text{font:20px X}"))))).not.toBeNull();
  expect(
    resolveSvgImageCssImports(
      image(dataUrl(Buffer.from(font + "svg{--distance:2c\\68;transform:translateX(var(--distance))}"))),
    ),
  ).toBeNull();
  const attribute = image(dataUrl(Buffer.from(font))).replace(
    "<svg>",
    '<svg style="font:20px X;transform:translateX(2ch)">',
  );
  expect(resolveSvgImageCssImports(attribute)).toBeNull();
});
