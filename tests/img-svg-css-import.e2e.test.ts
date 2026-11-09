import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { FIXTURE_FONT_CSS, FIXTURE_MONO_FAMILY, FIXTURE_SERIF_FAMILY } from "./fixture-fonts.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const externalSource = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
  <style>@import url("/import.css");</style>
  <rect id="paint" width="40" height="40" fill="green"/>
</svg>`;
const dataSource = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
  <style>@import url("data:text/css,rect%7Bfill%3Ared%7D");</style>
  <rect width="40" height="40" fill="green"/>
</svg>`;

describe("CSS imports in SVG image resources", () => {
  it("preserves imported layer and condition order for the root font cascade", async () => {
    const imported = `svg { font-size: 30px }`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><style>
      @import url("data:text/css,${encodeURIComponent(imported)}") layer(first) supports(display: block) screen;
      @layer second { svg { font-size: 40px } }
      svg { transform: translate(1em, 0); transform-origin: 0 0 }
    </style><rect width="20" height="20" fill="red"/></svg>`;
    const inlined = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "L-",
      supportsConditions: { "(display: block)": true },
    });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 210, height: 100 } });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(source)}" width="100" height="100" style="position:absolute;left:0;top:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
      );
      const pixels = await sharp(await page.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true });
      const color = (x: number): number[] => {
        const at = (10 * pixels.info.width + x) * pixels.info.channels;
        return Array.from(pixels.data.subarray(at, at + 3));
      };
      expect(color(45)).toEqual([255, 0, 0]);
      expect(color(35)).toEqual([255, 255, 255]);
      expect(color(155)).toEqual(color(45));
      expect(color(145)).toEqual(color(35));
    } finally {
      await page.close();
    }
  }, 60_000);

  it("uses a data-imported root font size for an em transform in image mode", async () => {
    const css = `svg { font-size: 30px; transform: translate(1em, 0); transform-origin: 0 0 }`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><style>@import url("data:text/css,${encodeURIComponent(css)}");</style><rect width="20" height="20" fill="red"/></svg>`;
    const inlined = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "P-",
    });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img id="image" src="data:image/svg+xml,${encodeURIComponent(source)}" style="position:absolute;left:0;top:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
      );
      const colors = await page.evaluate(async () => {
        const image = document.getElementById("image") as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 100;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return [10, 35].map((x) => Array.from(context.getImageData(x, 10, 1, 1).data));
      });
      expect(colors).toEqual([
        [0, 0, 0, 0],
        [255, 0, 0, 255],
      ]);
      const rendered = await page.screenshot();
      const pixels = await sharp(rendered).raw().toBuffer({ resolveWithObject: true });
      const color = (x: number, y: number): number[] => {
        const at = (y * pixels.info.width + x) * pixels.info.channels;
        return Array.from(pixels.data.subarray(at, at + 3));
      };
      expect(color(145, 10)).toEqual(color(35, 10));
      expect(color(120, 10)).toEqual(color(10, 10));
    } finally {
      await page.close();
    }
  }, 60_000);

  it("blocks HTTP and blob imports in image mode but allows data imports", async () => {
    const page = await browser.newPage();
    const inlinedExternal = inlineImgSvg(externalSource, {
      x: 0,
      y: 0,
      w: 40,
      h: 40,
      par: "xMidYMid meet",
      idPrefix: "E-",
    });
    expect(inlinedExternal).not.toBeNull();
    expect(inlinedExternal).not.toContain("@import");
    let cssRequests = 0;
    await page.route("https://domotion.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/import.css") {
        cssRequests++;
        await route.fulfill({ contentType: "text/css", body: "rect { fill: red } svg { font-size: 30px }" });
      } else if (path === "/image.svg") {
        await route.fulfill({ contentType: "image/svg+xml", body: externalSource });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body: `<img id="external" src="/image.svg"><img id="data"><img id="blob"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${inlinedExternal}</svg>`,
        });
      }
    });
    try {
      await page.goto("https://domotion.test/");
      await page.evaluate(async (source) => {
        const data = document.getElementById("data") as HTMLImageElement;
        data.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
        const cssUrl = URL.createObjectURL(new Blob(["rect { fill: red }"], { type: "text/css" }));
        const blobSource = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style>@import url("${cssUrl}");</style><rect width="40" height="40" fill="green"/></svg>`;
        const blob = document.getElementById("blob") as HTMLImageElement;
        blob.src = `data:image/svg+xml,${encodeURIComponent(blobSource)}`;
        await Promise.all(Array.from(document.images).map((image) => image.decode()));
      }, dataSource);
      const imageColors = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 40;
        canvas.height = 40;
        const context = canvas.getContext("2d")!;
        return ["external", "data", "blob"].map((id) => {
          context.clearRect(0, 0, 40, 40);
          context.drawImage(document.getElementById(id) as HTMLImageElement, 0, 0);
          return Array.from(context.getImageData(20, 20, 1, 1).data).slice(0, 3);
        });
      });
      const imageCssRequests = cssRequests;
      expect(await page.locator("#E-paint").evaluate((rect) => getComputedStyle(rect).fill)).toBe("rgb(0, 128, 0)");
      await page.goto("https://domotion.test/image.svg");
      const documentStyles = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          fill: getComputedStyle(document.querySelector("rect")!).fill,
          fontSize: getComputedStyle(root).fontSize,
        };
      });
      expect(imageColors).toEqual([
        [0, 128, 0],
        [255, 0, 0],
        [0, 128, 0],
      ]);
      expect(imageCssRequests).toBe(0);
      expect(documentStyles).toEqual({ fill: "rgb(255, 0, 0)", fontSize: "30px" });
      expect(cssRequests).toBe(1);
    } finally {
      await page.close();
    }
  }, 60_000);
});

const importedData = (bytes: Buffer, header = "text/css"): string =>
  `data:${header};base64,${bytes.toString("base64")}`;
const importedImage = (url: string, mode = "plain"): string => {
  const css = `@import url("${url}");`;
  const sheet = mode === "cdata" ? `<![CDATA[${css}]]>` : mode === "entity" ? css.replace("@", "&#64;") : css;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style>${sheet}</style><rect id="é" data-x="&lt;&amp;" width="40" height="40" fill="green"/></svg>`;
};
async function compareImportedImage(
  source: string,
  expectedColor?: number[],
  setup?: (page: Page) => Promise<void>,
): Promise<Buffer> {
  const inlined = inlineImgSvg(source, {
    x: 0,
    y: 0,
    w: 40,
    h: 40,
    par: "xMidYMid meet",
    documentViewport: true,
    idPrefix: "D-",
  });
  expect(inlined).not.toBeNull();
  const page = await browser.newPage({ viewport: { width: 90, height: 40 }, deviceScaleFactor: 1 });
  try {
    await setup?.(page);
    await page.setContent(
      `<body style="margin:0;background:white"><img width="40" height="40" style="position:absolute;left:0;top:0" src="data:image/svg+xml,${encodeURIComponent(source)}"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" style="position:absolute;left:50px;top:0">${inlined}</svg></body>`,
    );
    await page.locator("img").evaluate((img) => (img as HTMLImageElement).decode());
    const screenshot = await page.screenshot();
    const expected = await sharp(screenshot)
      .extract({ left: 0, top: 0, width: 40, height: 40 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const actual = await sharp(screenshot)
      .extract({ left: 50, top: 0, width: 40, height: 40 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(actual.equals(expected), "native image and inline pixels differ").toBe(true);
    if (expectedColor != null)
      expect([...expected.subarray((20 * 40 + 20) * 3, (20 * 40 + 20) * 3 + 3)]).toEqual(expectedColor);
    return expected;
  } finally {
    await page.close();
  }
}

describe("safe SVG data CSS byte/XML/resource expansion (DM-6ZX6W0)", () => {
  it.each([
    "text/css",
    "TEXT/CSS",
    "application/x-unknown-content-type",
    "text/plain",
    "application/css",
    "application/octet-stream",
    "",
  ])("matches strict image CSS MIME %s", async (mime) => {
    await compareImportedImage(
      importedImage(importedData(Buffer.from("rect{fill:red}"), mime)),
      ["text/css", "TEXT/CSS", "application/x-unknown-content-type"].includes(mime) ? [255, 0, 0] : [0, 128, 0],
    );
  });
  const css = '[id="é"]{fill:red}';
  const bytes1252 = Buffer.from(css, "latin1"),
    bytes16 = Buffer.from(css, "utf16le");
  const encodingCases = [
    { name: "Windows1252", head: "text/css;charset=windows-1252", bytes: bytes1252 },
    { name: "first nonempty charset", head: "text/css;charset=;charset=windows-1252", bytes: bytes1252 },
    { name: "Latin1", head: "text/css;charset=iso-8859-1", bytes: bytes1252 },
    { name: "UTF16LE", head: "text/css;charset=utf-16le", bytes: bytes16 },
    { name: "UTF16BE", head: "text/css;charset=utf-16be", bytes: Buffer.from(bytes16).swap16() },
    {
      name: "UTF8 BOM overrides Latin1",
      head: "text/css;charset=windows-1252",
      bytes: Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(css)]),
    },
    {
      name: "UTF16 BOM overrides UTF8",
      head: "text/css;charset=utf-8",
      bytes: Buffer.concat([Buffer.from([255, 254]), bytes16]),
    },
    {
      name: "transport charset wins",
      head: "text/css;charset=windows-1252",
      bytes: Buffer.from('@charset "utf-8";' + css, "latin1"),
    },
    { name: "in-band UTF16 becomes UTF8", head: "text/css", bytes: Buffer.from('@charset "utf-16le";' + css) },
    { name: "in-band charset", head: "text/css", bytes: Buffer.from('@charset "windows-1252";' + css, "latin1") },
    {
      name: "nested inherited encoding",
      head: "text/css;charset=windows-1252",
      bytes: Buffer.from('@import "data:text/css,%5Bid%3D%22%E9%22%5D%7Bfill%3Ared%7D";'),
    },
    { name: "CSS null/formfeed preprocessing", head: "text/css", bytes: Buffer.from("rect{fill:red}/*\0\f*/") },
  ];
  it.each(encodingCases)("matches native byte decoding: $name", async (sample) => {
    await compareImportedImage(importedImage(importedData(sample.bytes, sample.head)), [255, 0, 0]);
  });
  it.each(["cdata", "entity"])("expands imports from XML %s stylesheet text", async (mode) => {
    await compareImportedImage(importedImage(importedData(Buffer.from(css)), mode), [255, 0, 0]);
  });
  it("uses the native US-ASCII label's legacy byte mapping", async () => {
    await compareImportedImage(importedImage(importedData(Buffer.from(css), "text/css;charset=US-ASCII")), [0, 128, 0]);
  });
  it("canonicalizes a quoted data URL's surrounding URL whitespace", async () => {
    await compareImportedImage(importedImage(" data:text/css,rect%7Bfill%3Ared%7D "), [255, 0, 0]);
  });
  it("retains XML-sensitive imported selectors and comments in CDATA", async () => {
    await compareImportedImage(
      importedImage(importedData(Buffer.from('[data-x="<&"]{fill:red}/* <& */')), "cdata"),
      [255, 0, 0],
    );
  });
  it("preserves a split CDATA terminator in selector and declaration text", async () => {
    const css = '[data-x="]]>" ]{--value:"]]>";fill:red}';
    const source = importedImage(importedData(Buffer.from(css)), "cdata").replace(
      'data-x="&lt;&amp;"',
      'data-x="]]&gt;"',
    );
    await compareImportedImage(source, [255, 0, 0]);
  });
  it("preserves literal CDATA opening text and comment terminators", async () => {
    const css = '[data-x="<![CDATA[" ]{fill:red}/* <![CDATA[ ]]> */';
    const source = importedImage(importedData(Buffer.from(css)), "cdata").replace(
      'data-x="&lt;&amp;"',
      'data-x="&lt;![CDATA["',
    );
    await compareImportedImage(source, [255, 0, 0]);
  });
  it("keeps root font/transform cascade selectors intact across joined CDATA", async () => {
    const css =
      'svg[data-x="]]>" ]{font-size:30px;transform:translateX(1em);transform-origin:0 0}rect{fill:red;width:5px;height:20px}';
    const source = importedImage(importedData(Buffer.from(css)), "cdata").replace(
      "<svg xmlns=",
      '<svg data-x="]]&gt;" xmlns=',
    );
    await compareImportedImage(source);
  });
  it.each([
    { name: "external sheet", url: "https://blocked.test/a.css", media: "", color: [0, 0, 255] },
    { name: "rejected MIME", url: "data:text/plain,", media: "", color: [0, 0, 255] },
    { name: "false media", url: "data:text/css,", media: " not all", color: [255, 0, 0] },
    { name: "false supports", url: "data:text/css,", media: " supports(display: made-up)", color: [255, 0, 0] },
    { name: "true supports", url: "data:text/css,", media: " supports(display: block)", color: [0, 0, 255] },
  ])("preserves conditional import layer reservation: $name", async (sample) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style>@import "${sample.url}" layer(first)${sample.media};@layer second;@layer first{rect{fill:red}}@layer second{rect{fill:blue}}</style><rect width="40" height="40"/></svg>`;
    await compareImportedImage(source, sample.color);
  });
  it("allows imported data-font resources while keeping competing image families isolated", async () => {
    const source = (family: string): string => {
      const sheet =
        FIXTURE_FONT_CSS.replaceAll(family, "Imported]]><![CDATA[ Face") +
        `text{font:28px 'Imported]]><![CDATA[ Face'}`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><style>@import "${importedData(Buffer.from(sheet))}";</style><text x="2" y="34">Abc 01</text></svg>`;
    };
    const sources = [source(FIXTURE_MONO_FAMILY), source(FIXTURE_SERIF_FAMILY)];
    const inlined = sources.map((svg, index) =>
      inlineImgSvg(svg, {
        x: 0,
        y: index * 60,
        w: 100,
        h: 50,
        par: "xMidYMid meet",
        documentViewport: true,
        idPrefix: `F${index}-`,
      }),
    );
    expect(inlined.every((value) => value != null)).toBe(true);
    const page = await browser.newPage({ viewport: { width: 210, height: 110 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">${sources.map((svg, index) => `<img width="100" height="50" style="position:absolute;left:0;top:${index * 60}px" src="data:image/svg+xml,${encodeURIComponent(svg)}">`).join("")}<svg xmlns="http://www.w3.org/2000/svg" width="100" height="110" style="position:absolute;left:110px;top:0">${inlined.join("")}</svg></body>`,
      );
      await page
        .locator("img")
        .evaluateAll((images) => Promise.all(images.map((image) => (image as HTMLImageElement).decode())));
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const screenshot = await page.screenshot();
      const crops: Buffer[] = [];
      for (let index = 0; index < 2; index++) {
        const expected = await sharp(screenshot)
          .extract({ left: 0, top: index * 60, width: 100, height: 50 })
          .raw()
          .toBuffer();
        const actual = await sharp(screenshot)
          .extract({ left: 110, top: index * 60, width: 100, height: 50 })
          .raw()
          .toBuffer();
        expect(actual.equals(expected), "native image and inline pixels differ").toBe(true);
        crops.push(expected);
      }
      expect(crops[0]).not.toEqual(crops[1]);
    } finally {
      await page.close();
    }
  });
  it("retains raster when an imported author face would need root ch metrics", async () => {
    const css =
      FIXTURE_FONT_CSS.replaceAll(FIXTURE_MONO_FAMILY, "Metric Face") +
      `svg{font:20px 'Metric Face';transform:translateX(2ch);transform-origin:0 0}rect{fill:red}`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><style>@import "${importedData(Buffer.from(css))}";</style><rect width="10" height="20"/></svg>`;
    expect(
      inlineImgSvg(source, { x: 0, y: 0, w: 100, h: 40, par: "none", documentViewport: true, idPrefix: "M-" }),
    ).toBeNull();
    const page = await browser.newPage();
    try {
      const first = await page.evaluate(async (source) => {
        const img = new Image();
        img.src = "data:image/svg+xml," + encodeURIComponent(source);
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 100;
        canvas.height = 40;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 10, 100, 1).data;
        for (let x = 0; x < 100; x++)
          if (pixels[x * 4] === 255 && pixels[x * 4 + 1] === 0 && pixels[x * 4 + 3] === 255) return x;
        return -1;
      }, source);
      expect(first).toBe(24); // The old system-font fallback incorrectly translated20px.
    } finally {
      await page.close();
    }
  });
  const dataResource = (body: string): string =>
    "data:image/svg+xml," +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${body}</svg>`)
      .replaceAll("'", "%27")
      .replaceAll("(", "%28")
      .replaceAll(")", "%29") +
    "#paint";
  it.each([
    { prop: "fill", body: '<linearGradient id="paint"><stop stop-color="blue"/></linearGradient>' },
    {
      prop: "filter",
      body: '<filter id="paint" x="0" y="0" width="100%" height="100%"><feFlood flood-color="blue"/></filter>',
    },
    { prop: "mask", body: '<mask id="paint"><rect width="30" height="40" fill="white"/></mask>' },
  ])("matches the native canonical data SVG $prop resource", async (sample) => {
    const css = `rect{${sample.prop}:url("${dataResource(sample.body)}")${sample.prop === "fill" ? " red" : ""}}`;
    const pixels = await compareImportedImage(
      importedImage(importedData(Buffer.from(css))).replace('fill="green"', 'fill="red"'),
      sample.prop === "mask" ? [255, 0, 0] : [0, 0, 255],
    );
    if (sample.prop === "mask")
      expect([...pixels.subarray((20 * 40 + 35) * 3, (20 * 40 + 35) * 3 + 3)]).toEqual([255, 255, 255]);
  });
  it("does not open nested external loads through a data SVG resource", async () => {
    let requests = 0;
    const setup = async (page: Page): Promise<void> => {
      await page.route("https://resource.test/**", async (route) => {
        requests++;
        await route.fulfill({
          contentType: "image/svg+xml",
          headers: { "access-control-allow-origin": "*" },
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>',
        });
      });
    };
    const primitive =
      '<filter id="paint" x="0" y="0" width="100%" height="100%"><feImage href="https://resource.test/paint.svg" width="40" height="40"/></filter>';
    const control = await browser.newPage();
    try {
      await setup(control);
      await control.setContent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${primitive}<rect width="40" height="40" fill="red" filter="url(#paint)"/></svg>`,
      );
      await control.screenshot();
      expect(requests).toBe(1);
    } finally {
      await control.close();
    }
    const css = `rect{filter:url("${dataResource(primitive)}")}`;
    await compareImportedImage(importedImage(importedData(Buffer.from(css))), [255, 255, 255], setup);
    expect(requests).toBe(1);
  });
  it("keeps fragment and relative resources and escaped imports out of the host document", () => {
    for (const value of [
      "url(#host-paint)",
      "url(relative.svg#paint)",
      "url(https://host.test/paint.svg)",
      'image-set("https://host.test/image.png" 1x)',
    ])
      expect(
        inlineImgSvg(importedImage(importedData(Buffer.from(`rect{fill:${value}}`))), {
          x: 0,
          y: 0,
          w: 40,
          h: 40,
          par: "none",
          idPrefix: "R-",
        }),
      ).toBeNull();
    const escaped =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@\\69mport "https://host.test/a.css";</style></svg>';
    expect(inlineImgSvg(escaped, { x: 0, y: 0, w: 40, h: 40, par: "none", idPrefix: "R-" })).toBeNull();
    const invalidCharset = importedImage(
      importedData(Buffer.from("rect{fill:red}"), "text/css;charset=utf-8;charset=bad:value"),
    );
    expect(inlineImgSvg(invalidCharset, { x: 0, y: 0, w: 40, h: 40, par: "none", idPrefix: "C-" })).toBeNull();
  });
});
