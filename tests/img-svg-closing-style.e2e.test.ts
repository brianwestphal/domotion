import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureImageSvgSupports } from "../src/capture/image-svg-supports.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { cssUnescape } from "../src/render/svg-image-selector-engine.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { imageStyleSheets, xmlStyleText } from "../src/render/svg-image-stylesheets.js";

let browser: Browser;
const rows: Array<Record<string, unknown>> = [];
const width = 100,
  height = 60;
const mono = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
);
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  try {
    const directory = process.env.DOMOTION_STYLE_XML_EVIDENCE;
    if (directory != null) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "results.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            sourceCommit: process.env.GITHUB_SHA ?? null,
            platform: process.platform,
            arch: process.arch,
            browser: browser.version(),
            rows,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await closeBrowserSafely(browser, 15000);
  }
});
const xmlText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const style = (css: string, encoding: string) =>
  encoding === "import"
    ? `@import url("data:text/css;base64,${Buffer.from(css).toString("base64")}");`
    : encoding === "cdata"
      ? `<![CDATA[${css.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`
      : xmlText(css);

describe("literal closing-style XML data (DM-5D93J3)", () => {
  for (const encoding of ["import", "cdata", "references"]) {
    it(`matches native ${encoding} selectors, root font transform, media/supports and paint`, async () => {
      const css =
        '/* literal </style> comment */ svg{font-size:16px;transform:translate(1em,0);transform-origin:0 0} rect{--literal:"</style>";--noise:"/* @supports (fake:yes) {}"} @media (min-width:1px){@supports (display:block){[data-marker="</style>"]{fill:red}}}';
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style data-note=">">${style(css, encoding)}</style><defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient></defs><rect id="sample" data-marker="&lt;/style&gt;" width="20" height="20" fill="green"/></svg>`;
      await compare(source, encoding, true);
    });
    it(`preserves native ${encoding} local-resource paint after literal closing-style text`, async () => {
      const css =
        '/* </style> */ svg{font-size:16px;transform:translate(1em,0);transform-origin:0 0} rect{--literal:"</style>";fill:url(#paint)}';
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style>${style(css, encoding)}</style><defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient></defs><rect id="sample" width="20" height="20" fill="green"/></svg>`;
      await compare(source, `${encoding}-resource`, false);
    });
    it(`keeps native ${encoding} literal family/text values and image-owned font authority`, async () => {
      const family = "Imported</style> Face";
      const css = `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${mono.toString("base64")})}svg{font:20px "${family}";transform:translateX(2ch)}text{fill:blue}rect{--literal:"</style>";fill:red}`;
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style>${style(css, encoding)}</style><rect id="sample" width="10" height="10"/><text y="40">&lt;/style&gt;</text></svg>`;
      await compare(source, `${encoding}-font`, false, family);
    });
  }
  it("retains refusal for malformed XML instead of adopting partial stylesheet data", () => {
    for (const sheet of ["<style><![CDATA[rect{fill:red}</style>", '<style data-x="broken>rect{fill:red}</style>']) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${sheet}<rect width="10" height="10"/></svg>`;
      expect(
        inlineImgSvg(source, { x: 0, y: 0, w: 10, h: 10, par: "none", idPrefix: "invalid-", documentViewport: true }),
      ).toBeNull();
    }
  });
});
async function compare(source: string, name: string, supports: boolean, family?: string) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent(
      `<body style="margin:0;background:white"><img id="native" src="data:image/svg+xml,${encodeURIComponent(source)}" width="${width}" height="${height}">`,
    );
    await page.locator("#native").evaluate((image) => (image as HTMLImageElement).decode());
    const before = await page.screenshot();
    const el = capturedElement({
      tag: "img",
      imageSrc: `data:image/svg+xml,${encodeURIComponent(source)}`,
      children: [],
      brokenImageFallback: { source: { complete: true, naturalWidth: width } },
    });
    await captureImageSvgSupports(page, [el]);
    if (supports) expect(el.imageSvgSupports).toEqual({ "(display:block)": true });
    if (family != null) expect(el.imageOwnFonts?.faces.map((face) => face.family)).toEqual([family]);
    const inlined = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: width,
      h: height,
      par: "none",
      idPrefix: `closed-${name}-`,
      documentViewport: true,
      supportsConditions: el.imageSvgSupports,
      ownFonts: el.imageOwnFonts,
    });
    expect(inlined).not.toBeNull();
    await page.setContent(
      `<body style="margin:0;background:white"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${inlined}</svg>`,
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const after = await page.screenshot();
    const expected = await sharp(before).removeAlpha().raw().toBuffer();
    const actual = await sharp(after).removeAlpha().raw().toBuffer();
    expect(actual.length).toBe(expected.length);
    const redAt = (4 * width + (family == null ? 20 : 28)) * 3;
    expect([...expected.subarray(redAt, redAt + 3)]).toEqual([255, 0, 0]);
    const whiteAt = (4 * width + 4) * 3;
    expect([...expected.subarray(whiteAt, whiteAt + 3)]).toEqual([255, 255, 255]);
    let changed = 0,
      maxDelta = 0;
    for (let at = 0; at < actual.length; at += 3) {
      let differs = false;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(actual[at + channel] - expected[at + channel]);
        if (delta > 0) differs = true;
        maxDelta = Math.max(maxDelta, delta);
      }
      if (differs) changed++;
    }
    expect({ changed, maxDelta }).toEqual({ changed: 0, maxDelta: 0 });
    const sample = await page.locator('[id$="sample"]').evaluate((element) => ({
      literal: getComputedStyle(element).getPropertyValue("--literal").trim(),
      family: getComputedStyle(element).fontFamily,
      x: element.getBoundingClientRect().x,
    }));
    expect(cssUnescape(sample.literal)).toBe('"</style>"');
    expect(sample.x).toBe(family == null ? 16 : 24);
    if (family != null) expect(cssUnescape(sample.family)).toContain(family);
    expect(
      imageStyleSheets(inlined!)
        ?.map((sheet) => xmlStyleText(sheet.css))
        .join("\n"),
    ).toMatch(/style>/);
    const directory = process.env.DOMOTION_STYLE_XML_EVIDENCE;
    if (directory != null) {
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(join(directory, `${name}-source.png`), before),
        writeFile(join(directory, `${name}-captured.png`), after),
        writeFile(join(directory, `${name}-source.svg`), source),
        writeFile(join(directory, `${name}-captured.svg`), inlined!),
      ]);
    }
    rows.push({
      name,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      inlinedSha256: createHash("sha256").update(inlined!).digest("hex"),
      changed,
      maxDelta,
      expectedRgbSha256: createHash("sha256").update(expected).digest("hex"),
      actualRgbSha256: createHash("sha256").update(actual).digest("hex"),
      sample,
      imageFontFaces: el.imageOwnFonts?.faces.map((face) => ({ family: face.family, sha256: face.sha256 })) ?? [],
      supports: el.imageSvgSupports ?? null,
    });
  } finally {
    await page.close();
  }
}
