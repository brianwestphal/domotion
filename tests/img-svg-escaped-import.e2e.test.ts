import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { captureImageSvgSupports } from "../src/capture/image-svg-supports.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { resolveSvgImageCssImports } from "../src/render/svg-image-css-import.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser, server: Server, origin: string;
const requests: string[] = [],
  evidence: Array<Record<string, unknown>> = [];
const data = "data:text/css,rect%7Bfill:red%7D";
const image = (css: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style><![CDATA[${css.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>${defs}<rect id="sample" width="40" height="40" fill="green"/></svg>`;
const imported = (css: string) => image(`@import "data:text/css;base64,${Buffer.from(css).toString("base64")}";`);
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (path.endsWith(".css") || path.endsWith(".svg")) requests.push(path);
    if (path === "/import.css") {
      response.setHeader("content-type", "text/css");
      response.end("rect{fill:red}");
    } else if (path === "/filter.svg") {
      response.setHeader("content-type", "image/svg+xml");
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feFlood flood-color="blue"/></filter></svg>',
      );
    } else {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><body style="margin:0;background:white">');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("import fixture bind");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  try {
    const directory = process.env.DOMOTION_ESCAPED_IMPORT_EVIDENCE;
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
            rows: evidence,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await closeBrowserSafely(browser, 15000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function native(page: Page, source: string) {
  await page.setContent(
    `<body style="margin:0;background:white"><img id="native" width="40" height="40" src="data:image/svg+xml,${encodeURIComponent(source)}">`,
  );
  await page.locator("#native").evaluate((element) => (element as HTMLImageElement).decode());
  return page.screenshot();
}
async function rgb(png: Buffer) {
  return sharp(png).removeAlpha().raw().toBuffer();
}
async function compare(name: string, source: string, expectedColor = [255, 0, 0], label?: string) {
  const page = await browser.newPage({ viewport: { width: 40, height: 40 } });
  try {
    await page.goto(origin);
    const beforeRequests = requests.length;
    const before = await native(page, source),
      expected = await rgb(before);
    expect([...expected.subarray((4 * 40 + 4) * 3, (4 * 40 + 4) * 3 + 3)]).toEqual(expectedColor);
    const expanded = resolveSvgImageCssImports(source);
    expect(expanded).not.toBeNull();
    const captured = capturedElement({
      tag: "img",
      children: [],
      imageSrc: `data:image/svg+xml,${encodeURIComponent(source)}`,
      brokenImageFallback: { source: { complete: true, naturalWidth: 40 } },
    });
    await captureImageSvgSupports(page, [captured]);
    const supports = captured.imageSvgSupports;
    const output = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 40,
      h: 40,
      par: "none",
      idPrefix: `escaped-${name}-`,
      documentViewport: true,
      supportsConditions: supports,
    });
    expect(output).not.toBeNull();
    await page.setContent(
      `<body style="margin:0;background:white"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${output}</svg>`,
    );
    const after = await page.screenshot(),
      actual = await rgb(after);
    expect(actual).toEqual(expected);
    if (label != null)
      expect(
        await page
          .locator('[id$="sample"]')
          .evaluate((element) => getComputedStyle(element).getPropertyValue("--label")),
      ).toBe(label);
    expect(requests.slice(beforeRequests)).toEqual([]);
    const directory = process.env.DOMOTION_ESCAPED_IMPORT_EVIDENCE;
    if (directory != null) {
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(join(directory, `${name}-source.png`), before),
        writeFile(join(directory, `${name}-captured.png`), after),
        writeFile(join(directory, `${name}-source.svg`), source),
        writeFile(join(directory, `${name}-captured.svg`), output!),
      ]);
    }
    evidence.push({
      name,
      color: expectedColor,
      rgbSha256: createHash("sha256").update(actual).digest("hex"),
      exactPixels: true,
      extraRequests: requests.slice(beforeRequests),
      sourceSha256: createHash("sha256").update(source).digest("hex"),
    });
  } finally {
    await page.close();
  }
}
async function saveControls(files: Record<string, Buffer | string>): Promise<void> {
  const directory = process.env.DOMOTION_ESCAPED_IMPORT_EVIDENCE;
  if (directory == null) return;
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, data]) => writeFile(join(directory, name), data)));
}
const positives: Array<[string, string, string?]> = [
  ["hex-keyword", String.raw`@\69mport "${data}";`],
  ["hex-space-keyword", String.raw`@\69 mport "${data}";`],
  ["six-hex-keyword", String.raw`@\000069mport "${data}";`],
  ["simple-keyword", String.raw`@im\port "${data}";`],
  ["escaped-function", String.raw`@import \75 rl("${data}");`],
  ["escaped-scheme", String.raw`@import "d\61 ta:text/css,rect{fill:red}#sample{fill:blue}";`],
  ["unquoted-scheme", String.raw`@import url(d\61 ta:text/css,rect%7Bfill:red%7D);`],
  ["escaped-quotes", String.raw`@import "data:text/css,rect{--label:\"quote\";fill:red}";`, '"quote"'],
  [
    "quoted-parenthesis",
    String.raw`@import url("data:text/css,rect{--label:\"(quote)\";fill:red}"/* after string */);`,
    '"(quote)"',
  ],
  ["comment-data", String.raw`/* @\69mport "https://invalid.test/never.css" */ rect{fill:red}`],
  ["string-data", String.raw`rect{--label:"@\69mport";fill:red}`],
  ["CDO-keyword", String.raw`<!-- @\69 mport "${data}"; -->`],
  ["layer-supports", String.raw`@\69 mport "${data}" l\61 yer(first) sup\70 orts(display:block) screen;`],
];
describe("escaped image CSS imports/resources (DM-Y3H2EV)", () => {
  for (const [name, css, label] of positives)
    it(`matches native ${name}`, () => compare(name, image(css), [255, 0, 0], label));
  it("preserves late escaped import rejection", () =>
    compare("late", image(String.raw`rect{fill:green}@\69 mport "${data}";`), [0, 128, 0]));
  it("expands a nested escaped data import", () => compare("nested", imported(String.raw`@\69 mport "${data}";`)));
  it("authenticates and rewrites an escaped local fragment", () => {
    const css = String.raw`rect{filter:\75 rl(\23 p)}`;
    return compare(
      "local-filter",
      image(
        `@import "data:text/css;base64,${Buffer.from(css).toString("base64")}";`,
        '<defs><filter id="p"><feFlood flood-color="red"/></filter></defs>',
      ),
    );
  });
  it("keeps escaped independent data resource bytes inside the image", () => {
    const resource =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg"><filter id="p"><feFlood flood-color="red"/></filter></svg>',
      ) +
      "#p";
    return compare(
      "data-filter",
      imported(String.raw`rect{filter:\75 rl("${resource.replace(/^data:/, String.raw`d\61 ta:`)}")}`),
    );
  });
  for (const spelling of ["keyword", "scheme", "function", "blob"]) {
    it(`blocks ${spelling} image import while the original host import is live`, async () => {
      const page = await browser.newPage({ viewport: { width: 40, height: 40 } });
      let blob: string | undefined;
      try {
        await page.goto(origin);
        if (spelling === "blob")
          blob = await page.evaluate(() => URL.createObjectURL(new Blob(["rect{fill:red}"], { type: "text/css" })));
        const address = blob ?? origin + "/import.css";
        const css =
          spelling === "keyword"
            ? String.raw`@\69 mport "${address}";`
            : spelling === "scheme"
              ? `@import "${address.replace(/^http:/, String.raw`\68 ttp:`)}";`
              : spelling === "function"
                ? String.raw`@import \75 rl("${address}");`
                : `@import "${address}";`;
        const source = image(css),
          start = requests.length;
        const sourcePng = await native(page, source);
        const sourcePixels = await rgb(sourcePng);
        expect([...sourcePixels.subarray(0, 3)]).toEqual([0, 128, 0]);
        const output = inlineImgSvg(source, {
          x: 0,
          y: 0,
          w: 40,
          h: 40,
          par: "none",
          idPrefix: "blocked-",
          documentViewport: true,
        });
        expect(output).not.toBeNull();
        await page.setContent(
          `<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${output}</svg>`,
        );
        const capturedPng = await page.screenshot();
        expect(await rgb(capturedPng)).toEqual(sourcePixels);
        expect(requests.slice(start)).toEqual([]);
        await page.setContent(`<body style="margin:0">${source}`);
        await expect
          .poll(() => page.locator("rect").evaluate((element) => getComputedStyle(element).fill), { timeout: 5000 })
          .toBe("rgb(255, 0, 0)");
        const hostPng = await page.screenshot();
        expect([...(await rgb(hostPng)).subarray(0, 3)]).toEqual([255, 0, 0]);
        await saveControls({
          [`blocked-${spelling}-source.png`]: sourcePng,
          [`blocked-${spelling}-captured.png`]: capturedPng,
          [`blocked-${spelling}-host.png`]: hostPng,
          [`blocked-${spelling}-source.svg`]: source,
          [`blocked-${spelling}-captured.svg`]: output!,
        });
        expect(requests.slice(start)).toEqual(spelling === "blob" ? [] : ["/import.css"]);
        evidence.push({
          name: `blocked-${spelling}`,
          imageColor: [0, 128, 0],
          outputExact: true,
          hostColor: [255, 0, 0],
          hostRequests: requests.slice(start),
        });
      } finally {
        if (blob != null) await page.evaluate((url) => URL.revokeObjectURL(url), blob).catch(() => undefined);
        await page.close();
      }
    });
  }
  it("refuses XML resource/style case aliases while preserving active canonical href", async () => {
    const blue =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>',
      );
    for (const attribute of ["HREF", "hReF", "STYLE"]) {
      const page = await browser.newPage({ viewport: { width: 40, height: 40 } });
      try {
        const body =
          attribute === "STYLE"
            ? '<rect width="40" height="40" STYLE="fill:blue"/>'
            : `<image ${attribute}="${blue}" width="40" height="40"/>`;
        const source = image(String.raw`@\69mport "${data}";`).replace("</svg>", body + "</svg>");
        const sourcePng = await native(page, source);
        expect([...(await rgb(sourcePng)).subarray(0, 3)]).toEqual([255, 0, 0]);
        expect(
          inlineImgSvg(source, { x: 0, y: 0, w: 40, h: 40, par: "none", idPrefix: "alias-", documentViewport: true }),
        ).toBeNull();
        await page.setContent(`<body style="margin:0">${source}`);
        await expect.poll(async () => [...(await rgb(await page.screenshot())).subarray(0, 3)]).toEqual([0, 0, 255]);
        const hostPng = await page.screenshot();
        await saveControls({
          [`alias-${attribute}-source.png`]: sourcePng,
          [`alias-${attribute}-host.png`]: hostPng,
          [`alias-${attribute}-source.svg`]: source,
        });
        evidence.push({
          name: `alias-${attribute}`,
          sourceColor: [255, 0, 0],
          refused: true,
          hostColor: [0, 0, 255],
          followUp: "DM-SC5Y23",
        });
      } finally {
        await page.close();
      }
    }
    const source = image(String.raw`@\69mport "${data}";`).replace(
      "</svg>",
      `<image href="${blue}" width="40" height="40"/></svg>`,
    );
    await compare("canonical-href", source, [0, 0, 255]);
  });
  it("refuses an escaped live external declaration resource instead of opening host loading", async () => {
    const page = await browser.newPage({ viewport: { width: 40, height: 40 } });
    try {
      await page.goto(origin);
      const source = imported(
          String.raw`rect{filter:\75 rl("${(origin + "/filter.svg#f").replace(/^http:/, String.raw`\68 ttp:`)}")}`,
        ),
        start = requests.length;
      const sourcePng = await native(page, source);
      expect([...(await rgb(sourcePng)).subarray(0, 3)]).toEqual([0, 128, 0]);
      expect(
        inlineImgSvg(source, {
          x: 0,
          y: 0,
          w: 40,
          h: 40,
          par: "none",
          idPrefix: "external-filter-",
          documentViewport: true,
        }),
      ).toBeNull();
      expect(requests.slice(start)).toEqual([]);
      await page.setContent(`<body style="margin:0">${source}`);
      await expect
        .poll(async () => [...(await rgb(await page.screenshot())).subarray(0, 3)], { timeout: 5000 })
        .toEqual([0, 0, 255]);
      expect(requests.slice(start)).toEqual(["/filter.svg"]);
      const hostPng = await page.screenshot();
      await saveControls({
        "refused-external-filter-source.png": sourcePng,
        "refused-external-filter-host.png": hostPng,
        "refused-external-filter-source.svg": source,
      });
      evidence.push({
        name: "refused-external-filter",
        imageColor: [0, 128, 0],
        refused: true,
        hostColor: [0, 0, 255],
        hostRequests: requests.slice(start),
      });
    } finally {
      await page.close();
    }
  });
});
