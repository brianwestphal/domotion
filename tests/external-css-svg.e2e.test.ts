import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { primeExternalCssSvgReferences } from "../src/capture/external-css-svg.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const SPRITE =
  '<svg xmlns="http://www.w3.org/2000/svg"><clipPath id="clip" clipPathUnits="userSpaceOnUse"><rect width="16" height="32"/></clipPath><mask id="mask" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="16" height="32" fill="white"/></mask></svg>';
let server: Server;
let browser: Browser;
let origin: string;
const requests: Array<{ path: string; destination: string; closed: boolean; cookie: string }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const fact = {
      path: url.pathname,
      destination: String(request.headers["sec-fetch-dest"] ?? ""),
      closed: false,
      cookie: request.headers.cookie ?? "",
    };
    requests.push(fact);
    response.once("close", () => {
      fact.closed = true;
    });
    if (url.pathname.endsWith(".svg")) {
      if (url.pathname === "/cookie.svg" && request.headers.cookie !== "sprite=authorized") {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("content-type", "image/svg+xml");
      if (url.pathname === "/stalled.svg") {
        response.write('<svg xmlns="http://www.w3.org/2000/svg">');
        return;
      }
      response.end(SPRITE);
    } else {
      const kind = url.searchParams.get("kind") === "mask" ? "mask" : "clip";
      const property = kind === "clip" ? "clip-path" : "mask-image";
      response.setHeader("content-type", "text/html");
      if (url.searchParams.get("csp") === "blocked")
        response.setHeader("content-security-policy", "connect-src 'none'");
      const asset =
        url.searchParams.get("asset") === "stalled"
          ? "/stalled.svg"
          : url.searchParams.get("asset") === "cookie"
            ? "/cookie.svg"
            : "/sprite.svg";
      const fragment = url.searchParams.get("fragment") === "missing" ? "missing" : kind;
      response.end(
        `<!doctype html><body style="margin:0;background:white"><div id="box" style="width:32px; height:32px; background:red; ${property}:url(${asset}#${fragment}) !important; --sentinel: author"></div>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("CSS SVG fixture failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await closeBrowserSafely(browser, 15_000);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function pixels(page: Page) {
  return sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer();
}

describe("owned CSS SVG fragment prepass (DM-HK7GEB)", () => {
  it("uses source-context cookies for its renderer-owned resource read", async () => {
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: "sprite", value: "authorized", url: origin }]);
      const page = await context.newPage();
      await page.goto(`${origin}/?asset=cookie`);
      await freezeRealWorldDom(page);
      const start = requests.length;
      const prime = await primeExternalCssSvgReferences(page);
      await prime.dispose();
      expect(
        requests
          .slice(start)
          .filter((request) => request.path === "/cookie.svg" && request.destination === "empty")
          .map((request) => request.cookie),
      ).toEqual(["sprite=authorized"]);
    } finally {
      await context.close();
    }
  });
  it("replays the same frozen CSS resource from ordinary HAR without a live server request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domotion-css-har-"));
    const path = join(directory, "fixture.har");
    let context = await browser.newContext({
      viewport: { width: 64, height: 64 },
      recordHar: { path, content: "embed" },
    });
    try {
      let page = await context.newPage();
      await page.goto(origin);
      const expected = await pixels(page);
      const recorded = await primeExternalCssSvgReferences(page);
      await recorded.dispose();
      await context.close();
      const start = requests.length;
      context = await browser.newContext({ viewport: { width: 64, height: 64 } });
      await context.routeFromHAR(path, { notFound: "abort" });
      page = await context.newPage();
      await page.goto(origin);
      await freezeRealWorldDom(page);
      const replayed = await primeExternalCssSvgReferences(page);
      try {
        expect((await pixels(page)).equals(expected)).toBe(true);
      } finally {
        await replayed.dispose();
      }
      expect(requests).toHaveLength(start);
    } finally {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["clip", "mask"] as const)("refuses CSP-blocked %s reads without changing painted source", async (kind) => {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    try {
      await page.goto(`${origin}/?kind=${kind}&csp=blocked`);
      const before = await pixels(page);
      const style = await page.locator("#box").getAttribute("style");
      await freezeRealWorldDom(page);
      await expect(
        captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 64, height: 64 }, {}),
      ).rejects.toThrow("external CSS SVG resource could not be read");
      expect(await page.locator("#box").getAttribute("style")).toBe(style);
      expect((await pixels(page)).equals(before)).toBe(true);
      expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it.each(["clip", "mask"] as const)("preserves the existing missing %s fragment outcome", async (kind) => {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    try {
      await page.goto(`${origin}/?kind=${kind}&fragment=missing`);
      const before = await pixels(page);
      const style = await page.locator("#box").getAttribute("style");
      const prime = await primeExternalCssSvgReferences(page);
      await prime.dispose();
      expect(await page.locator("#box").getAttribute("style")).toBe(style);
      expect((await pixels(page)).equals(before)).toBe(true);
    } finally {
      await page.close();
    }
  });
  it("preserves foreign style changes while restoring only its owned property", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const property = await page.locator("#box").evaluate((element) => ({
        value: (element as HTMLElement).style.clipPath,
        priority: (element as HTMLElement).style.getPropertyPriority("clip-path"),
      }));
      const prime = await primeExternalCssSvgReferences(page);
      await page
        .locator("#box")
        .evaluate((element) => (element as HTMLElement).style.setProperty("--foreign", "retained"));
      await prime.dispose();
      expect(
        await page.locator("#box").evaluate((element) => ({
          value: (element as HTMLElement).style.clipPath,
          priority: (element as HTMLElement).style.getPropertyPriority("clip-path"),
          foreign: (element as HTMLElement).style.getPropertyValue("--foreign"),
        })),
      ).toEqual({ ...property, foreign: "retained" });
    } finally {
      await page.close();
    }
  });
  it("does not satisfy a dangling author reference to an earlier private definition", async () => {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    try {
      await page.goto(origin);
      const first = await primeExternalCssSvgReferences(page);
      const oldId = await page.locator('svg [id^="__domotionCssSvgDefinition_"]').getAttribute("id");
      expect(oldId).not.toBeNull();
      await first.dispose();
      await page.evaluate((id) => {
        const foreign = document.createElement("div");
        foreign.style.cssText = `position:absolute;left:0;top:32px;width:32px;height:32px;background:blue;clip-path:url(#${id})`;
        document.body.appendChild(foreign);
      }, oldId);
      const before = await pixels(page);
      const second = await primeExternalCssSvgReferences(page);
      try {
        expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').getAttribute("id")).not.toBe(oldId);
        expect((await pixels(page)).equals(before)).toBe(true);
      } finally {
        await second.dispose();
      }
    } finally {
      await page.close();
    }
  });
  it.each([
    { kind: "clip", encoding: "literal" },
    { kind: "clip", encoding: "percent" },
    { kind: "mask", encoding: "literal" },
    { kind: "mask", encoding: "percent" },
  ])(
    "retains $encoding adopted $kind definitions on cleanup failure and supports a safe retry",
    async ({ kind, encoding }) => {
      const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
      try {
        await page.goto(`${origin}/?kind=${kind}`);
        const original = await page.locator("#box").getAttribute("style");
        const prime = await primeExternalCssSvgReferences(page);
        await page.evaluate(
          ({ kind, encoding }) => {
            const property = kind === "clip" ? "clip-path" : "mask-image";
            const foreign = document.createElement("div");
            foreign.id = "foreign";
            foreign.style.cssText = "position:absolute;left:0;top:32px;width:32px;height:32px;background:blue";
            let value = (document.querySelector("#box") as HTMLElement).style.getPropertyValue(property);
            if (encoding === "percent") value = value.replace("#_", "#%5F");
            foreign.style.setProperty(property, value);
            document.body.appendChild(foreign);
          },
          { kind, encoding },
        );
        const before = await pixels(page);
        expect([...before.subarray((40 * 64 + 4) * 3, (40 * 64 + 4) * 3 + 3)]).toEqual([0, 0, 255]);
        expect([...before.subarray((40 * 64 + 24) * 3, (40 * 64 + 24) * 3 + 3)]).toEqual([255, 255, 255]);
        await expect(prime.dispose()).rejects.toThrow("cleanup operations unconfirmed");
        expect((await pixels(page)).equals(before)).toBe(true);
        expect(await page.evaluate((key) => Reflect.has(globalThis, key), prime.registryKey)).toBe(true);
        expect(await page.locator("#box").getAttribute("style")).toBe(original);
        expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(1);
        await page.locator("#foreign").evaluate((element) => element.remove());
        await prime.dispose();
        expect(await page.evaluate((key) => Reflect.has(globalThis, key), prime.registryKey)).toBe(false);
      } finally {
        await page.close();
      }
    },
  );
  it("refuses a stalled body within the Node-owned bound and aborts only its fetch", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?asset=stalled`, { waitUntil: "domcontentloaded" });
      const style = await page.locator("#box").getAttribute("style");
      await freezeRealWorldDom(page);
      const started = performance.now();
      await expect(primeExternalCssSvgReferences(page)).rejects.toThrow("external CSS SVG resource could not be read");
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(await page.locator("#box").getAttribute("style")).toBe(style);
      expect(
        requests.filter((request) => request.path === "/stalled.svg" && request.destination === "empty"),
      ).toHaveLength(1);
      await expect
        .poll(() =>
          requests
            .filter((request) => request.path === "/stalled.svg" && request.destination === "empty")
            .every((request) => request.closed),
        )
        .toBe(true);
      expect(
        requests.some(
          (request) => request.path === "/stalled.svg" && request.destination === "image" && !request.closed,
        ),
      ).toBe(true);
    } finally {
      await page.close();
    }
  }, 15_000);
  it("rolls back a setter which mutates the source and then throws", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const before = await page.locator("#box").getAttribute("style");
      await page.evaluate(() => {
        const original = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
          original.call(this, name, value, priority);
          if (name === "clip-path" && value?.includes("#__domotionCssSvgDefinition_"))
            throw new Error("controlled partial setter failure");
        };
      });
      await expect(primeExternalCssSvgReferences(page)).rejects.toThrow("controlled partial setter failure");
      expect(await page.locator("#box").getAttribute("style")).toBe(before);
      expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("retains cleanup state after a restoration exception and retries without losing ownership", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const before = await page.locator("#box").getAttribute("style");
      const prime = await primeExternalCssSvgReferences(page);
      await page.locator("#box").evaluate((element) => {
        Object.defineProperty(element, "setAttribute", {
          configurable: true,
          value() {
            throw new Error("controlled restore failure");
          },
        });
      });
      await expect(prime.dispose()).rejects.toThrow("cleanup operations unconfirmed");
      expect(await page.evaluate((key) => Reflect.has(globalThis, key), prime.registryKey)).toBe(true);
      expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(1);
      await page.locator("#box").evaluate((element) => Reflect.deleteProperty(element, "setAttribute"));
      await prime.dispose();
      expect(await page.locator("#box").getAttribute("style")).toBe(before);
      expect(await page.evaluate((key) => Reflect.has(globalThis, key), prime.registryKey)).toBe(false);
    } finally {
      await page.close();
    }
  });
  it("restores CSS definitions after a later production capture failure", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const before = await page.locator("#box").getAttribute("style");
      await expect(
        captureElementTreeWithWarnings(page, "[", { x: 0, y: 0, width: 64, height: 64 }, {}),
      ).rejects.toThrow();
      expect(await page.locator("#box").getAttribute("style")).toBe(before);
      expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it.each(["clip", "mask"] as const)(
    "preserves frozen %s paint and exactly restores source style and definitions",
    async (kind) => {
      const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/?kind=${kind}`);
        const original = await page.locator("#box").getAttribute("style");
        const before = await pixels(page);
        expect([...before.subarray((16 * 64 + 8) * 3, (16 * 64 + 8) * 3 + 3)]).toEqual([255, 0, 0]);
        expect([...before.subarray((16 * 64 + 24) * 3, (16 * 64 + 24) * 3 + 3)]).toEqual([255, 255, 255]);
        expect(await freezeRealWorldDom(page)).toBe(true);
        const prime = await primeExternalCssSvgReferences(page);
        const ids = await page.evaluate(
          (key) => (globalThis as typeof globalThis & Record<string, { ids: string[] }>)[key].ids,
          prime.registryKey,
        );
        try {
          expect((await pixels(page)).equals(before)).toBe(true);
          expect(await page.locator("#box").getAttribute("style")).not.toBe(original);
        } finally {
          await prime.dispose();
        }
        await prime.dispose();
        expect(await page.locator("#box").getAttribute("style")).toBe(original);
        expect((await pixels(page)).equals(before)).toBe(true);
        expect(await page.evaluate((key) => Reflect.has(globalThis, key), prime.registryKey)).toBe(false);
        expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
        const repeated = await primeExternalCssSvgReferences(page);
        try {
          expect(
            await page.evaluate(
              (key) => (globalThis as typeof globalThis & Record<string, { ids: string[] }>)[key].ids,
              repeated.registryKey,
            ),
          ).toEqual(ids);
        } finally {
          await repeated.dispose();
        }
        expect(await page.locator("#box").getAttribute("style")).toBe(original);
      } finally {
        await context.close();
      }
    },
  );
  it.each(["clip", "mask"] as const)(
    "captures frozen %s through the production pipeline and restores its source",
    async (kind) => {
      const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/?kind=${kind}`);
        const style = await page.locator("#box").getAttribute("style");
        const before = await pixels(page);
        await freezeRealWorldDom(page);
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 64, height: 64 }, {});
        expect(
          captured.warnings.filter((warning) => warning.feature === "clip-path" || warning.feature === "mask"),
        ).toEqual([]);
        const svg = elementTreeToSvg(captured.tree, 64, 64, {});
        const output = await context.newPage();
        await output.setContent(`<body style="margin:0">${svg}`);
        expect((await pixels(output)).equals(before)).toBe(true);
        expect(await page.locator("#box").getAttribute("style")).toBe(style);
        expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
        const directory = join(
          process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
          "external-svg-frozen",
          "css-fragments",
        );
        await mkdir(directory, { recursive: true });
        await Promise.all([
          writeFile(join(directory, `${kind}-source.png`), await page.screenshot()),
          writeFile(join(directory, `${kind}-captured.png`), await output.screenshot()),
          writeFile(join(directory, `${kind}.svg`), svg),
          writeFile(
            join(directory, `${kind}-evidence.json`),
            JSON.stringify(
              {
                generatedAt: new Date().toISOString(),
                sourceCommit: process.env["GITHUB_SHA"] ?? null,
                platform: process.platform,
                browser: browser.version(),
                kind,
                frozen: true,
                byteIdenticalPixels: true,
                originalStyle: style,
                exactStyleRestored: true,
                ownedDefinitionsRemaining: 0,
              },
              null,
              2,
            ),
          ),
        ]);
      } finally {
        await context.close();
      }
    },
  );
});
