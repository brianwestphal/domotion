import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturedTree } from "../src/test-support/captured-fixtures.js";
import type { ExternalCssSvgJournal } from "../src/capture/external-css-svg.js";
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
      if (url.pathname === "/missing.svg") {
        response.writeHead(404).end("missing");
        return;
      }
      if (url.pathname === "/cookie.svg" && request.headers.cookie !== "sprite=authorized") {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("content-type", "image/svg+xml");
      if (url.pathname === "/stalled.svg") {
        response.write('<svg xmlns="http://www.w3.org/2000/svg">');
        return;
      }
      response.end(url.pathname === "/child.svg" ? SPRITE.replaceAll('width="16"', 'width="8"') : SPRITE);
    } else {
      const kind = url.searchParams.get("kind") === "mask" ? "mask" : "clip";
      const property = kind === "clip" ? "clip-path" : "mask-image";
      response.setHeader("content-type", "text/html");
      if (url.searchParams.get("csp") === "blocked")
        response.setHeader("content-security-policy", "connect-src 'none'");
      if (url.searchParams.get("csp") === "child")
        response.setHeader("content-security-policy", `connect-src ${origin}/child.svg`);
      const asset =
        url.searchParams.get("asset") === "stalled"
          ? "/stalled.svg"
          : url.searchParams.get("asset") === "cookie"
            ? "/cookie.svg"
            : url.searchParams.get("asset") === "missing"
              ? "/missing.svg"
              : "/sprite.svg";
      const fragment = url.searchParams.get("fragment") === "missing" ? "missing" : kind;
      response.end(
        `<!doctype html><body style="margin:0;background:white"><div id="box" style="width:32px; height:32px; background:red; ${property}:url(${asset}#${fragment}) !important; --sentinel: author">${url.searchParams.has("compound") ? '<div style="width:32px;height:32px;background:blue;mask-image:url(/child.svg#mask)"></div>' : ""}</div>`,
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
async function nativeOwner(page: Page) {
  const prime = await primeExternalCssSvgReferences(page);
  const token = await page.evaluate(
    (key) =>
      [...((globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal).rasterOwners.values()][0]?.token,
    prime.registryKey,
  );
  if (token == null) throw new Error("fixture did not select a native CSS owner");
  return {
    prime,
    tree: capturedTree([
      {
        tag: "div",
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        children: [],
        externalCssSvgRaster: { token, x: 0, y: 0, width: 32, height: 32 },
      },
    ]),
  };
}
const viewport = { x: 0, y: 0, width: 64, height: 64 };

describe("owned CSS SVG fragment prepass (DM-HK7GEB)", () => {
  it("keeps a readable descendant resource native inside an unreadable parent owner", async () => {
    const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?csp=child&compound=1`);
      const before = await pixels(page);
      expect([...before.subarray((16 * 64 + 4) * 3, (16 * 64 + 4) * 3 + 3)]).toEqual([0, 0, 255]);
      expect([...before.subarray((16 * 64 + 12) * 3, (16 * 64 + 12) * 3 + 3)]).toEqual([255, 0, 0]);
      const childStyle = await page.locator("#box > div").getAttribute("style");
      await freezeRealWorldDom(page);
      const result = await captureElementTreeWithWarnings(page, "body", viewport, {});
      expect(
        result.warnings.filter((warning) => warning.feature === "clip-path" || warning.feature === "mask"),
      ).toEqual([]);
      const output = await context.newPage();
      await output.setContent(`<body style="margin:0">${elementTreeToSvg(result.tree, 64, 64, {})}`);
      expect((await pixels(output)).equals(before)).toBe(true);
      expect(await page.locator("#box > div").getAttribute("style")).toBe(childStyle);
      expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
  it.each(["clip", "mask"] as const)("retains native %s paint for an actually missing resource", async (kind) => {
    const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?kind=${kind}&asset=missing`);
      const before = await pixels(page);
      expect([...before.subarray((16 * 64 + 8) * 3, (16 * 64 + 8) * 3 + 3)]).toEqual(
        kind === "clip" ? [255, 0, 0] : [255, 255, 255],
      );
      const style = await page.locator("#box").getAttribute("style");
      await freezeRealWorldDom(page);
      const result = await captureElementTreeWithWarnings(page, "body", viewport, {});
      const output = await context.newPage();
      await output.setContent(`<body style="margin:0">${elementTreeToSvg(result.tree, 64, 64, {})}`);
      expect((await pixels(output)).equals(before)).toBe(true);
      expect(await page.locator("#box").getAttribute("style")).toBe(style);
    } finally {
      await context.close();
    }
  });
  it("preserves a scrolled native CSS owner in the capture viewport", async () => {
    const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?csp=blocked`);
      await page.evaluate(() => {
        document.body.style.height = "240px";
        const spacer = document.createElement("div");
        spacer.style.height = "80px";
        document.querySelector("#box")!.before(spacer);
        scrollTo(0, 64);
      });
      expect(await page.evaluate(() => scrollY)).toBe(64);
      const before = await pixels(page);
      expect([...before.subarray((32 * 64 + 8) * 3, (32 * 64 + 8) * 3 + 3)]).toEqual([255, 0, 0]);
      await freezeRealWorldDom(page);
      const result = await captureElementTreeWithWarnings(page, "body", viewport, {});
      const output = await context.newPage();
      await output.setContent(`<body style="margin:0">${elementTreeToSvg(result.tree, 64, 64, {})}`);
      expect((await pixels(output)).equals(before)).toBe(true);
      expect(await page.evaluate(() => scrollY)).toBe(64);
    } finally {
      await context.close();
    }
  });
  it.each(["clip", "mask"] as const)(
    "keeps generated paint, hidden descendants and overlapping siblings atomic for %s",
    async (kind) => {
      const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/?kind=${kind}&csp=blocked`);
        await page.addStyleTag({
          content:
            '#box{position:relative;z-index:2}#box::before{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;background:blue;z-index:9}',
        });
        await page.locator("#box").evaluate((element) => {
          const hidden = document.createElement("div");
          hidden.style.cssText = "visibility:hidden;position:absolute;inset:0;background:yellow";
          element.appendChild(hidden);
          const control = document.createElement("input");
          control.type = "checkbox";
          control.defaultChecked = true;
          control.style.cssText = "position:absolute;left:0;top:0;width:12px;height:12px;margin:0;z-index:12";
          element.appendChild(control);
          const sibling = document.createElement("div");
          sibling.style.cssText =
            "position:absolute;left:8px;top:8px;width:20px;height:20px;background:green;z-index:3";
          document.body.appendChild(sibling);
        });
        const before = await pixels(page);
        await freezeRealWorldDom(page);
        const result = await captureElementTreeWithWarnings(page, "body", viewport, {});
        const output = await context.newPage();
        await output.setContent(`<body style="margin:0">${elementTreeToSvg(result.tree, 64, 64, {})}`);
        expect((await pixels(output)).equals(before)).toBe(true);
        expect((await pixels(page)).equals(before)).toBe(true);
      } finally {
        await context.close();
      }
    },
  );
  it.each(["opacity", "clipping", "text"] as const)(
    "refuses unsupported ancestor %s without changing source paint",
    async (effect) => {
      const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
      try {
        await page.goto(`${origin}/?csp=blocked`);
        await page.locator("#box").evaluate((element, effect) => {
          const wrapper = document.createElement("div");
          wrapper.style.cssText =
            effect === "opacity" ? "opacity:.5" : effect === "clipping" ? "overflow:hidden;width:16px;height:16px" : "";
          element.replaceWith(wrapper);
          wrapper.appendChild(element);
          if (effect === "text") wrapper.append("native ancestor text");
        }, effect);
        const before = await pixels(page);
        const { prime, tree } = await nativeOwner(page);
        try {
          await expect(prime.rasterize(tree, viewport)).rejects.toThrow("unsupported ancestor");
        } finally {
          await prime.dispose();
        }
        expect((await pixels(page)).equals(before)).toBe(true);
      } finally {
        await page.close();
      }
    },
  );
  it("refuses a selected property change before native isolation", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      const { prime, tree } = await nativeOwner(page);
      await page
        .locator("#box")
        .evaluate((element) => (element as HTMLElement).style.setProperty("clip-path", "none", "important"));
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("selection changed");
      } finally {
        await prime.dispose();
      }
      expect(await page.locator("#box").evaluate((element) => getComputedStyle(element).clipPath)).toBe("none");
    } finally {
      await page.close();
    }
  });
  it("refuses inherited paint changes caused by ancestor isolation and restores source", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      await page.evaluate(() => {
        document.body.style.backgroundColor = "blue";
        (document.querySelector("#box") as HTMLElement).style.background = "inherit";
      });
      const before = await page.content();
      const { prime, tree } = await nativeOwner(page);
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("changed inherited owner paint");
      } finally {
        await prime.dispose();
      }
      expect(await page.content()).toBe(before);
    } finally {
      await page.close();
    }
  });
  it("refuses a visible local mask dependency outside the native owner instead of hiding it", async () => {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    try {
      await page.goto(`${origin}/?csp=blocked`);
      await page.evaluate(() => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.innerHTML =
          '<defs><mask id="outside-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="8" height="32" fill="white"/></mask></defs>';
        document.body.appendChild(svg);
        const child = document.createElement("div");
        child.style.cssText = "width:32px;height:32px;background:blue;mask-image:url(#outside-mask)";
        document.querySelector("#box")!.appendChild(child);
      });
      const before = await pixels(page);
      expect([...before.subarray((16 * 64 + 4) * 3, (16 * 64 + 4) * 3 + 3)]).toEqual([0, 0, 255]);
      const { prime, tree } = await nativeOwner(page);
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("outside local-definition dependency");
      } finally {
        await prime.dispose();
      }
      expect((await pixels(page)).equals(before)).toBe(true);
    } finally {
      await page.close();
    }
  });
  it("refuses a potential visibility transition before changing source animation state", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      await page.evaluate(() => {
        const foreign = document.createElement("div");
        foreign.style.cssText = "transition:visibility 1s;width:8px;height:8px;background:green";
        document.body.appendChild(foreign);
      });
      const before = await page.content();
      const { prime, tree } = await nativeOwner(page);
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("unsupported transition channels");
      } finally {
        await prime.dispose();
      }
      expect(await page.content()).toBe(before);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("refuses native owner tokens from another browser context", async () => {
    const a = await browser.newPage();
    const b = await browser.newPage();
    try {
      await Promise.all([a.goto(`${origin}/?csp=blocked`), b.goto(`${origin}/?csp=blocked`)]);
      const first = await nativeOwner(a),
        second = await nativeOwner(b);
      try {
        await expect(first.prime.rasterize(second.tree, viewport)).rejects.toThrow("owner identity unavailable");
      } finally {
        await first.prime.dispose();
        await second.prime.dispose();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
  it("refuses an owner adopted into a same-origin child document", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      const { prime, tree } = await nativeOwner(page);
      await page.evaluate(async () => {
        const frame = document.createElement("iframe");
        frame.srcdoc = "<!doctype html><body></body>";
        const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
        document.body.appendChild(frame);
        await loaded;
        frame.contentDocument!.body.appendChild(document.querySelector("#box")!);
      });
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("owner document identity unavailable");
      } finally {
        await prime.dispose();
      }
      expect(
        await page
          .frames()
          .find((frame) => frame !== page.mainFrame())!
          .locator("#box")
          .count(),
      ).toBe(1);
    } finally {
      await page.close();
    }
  });
  it("restores native isolation after a screenshot exception", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      const before = await page.content();
      const { prime, tree } = await nativeOwner(page);
      const screenshot = vi.spyOn(page, "screenshot").mockRejectedValue(new Error("controlled screenshot failure"));
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("controlled screenshot failure");
      } finally {
        screenshot.mockRestore();
        await prime.dispose();
      }
      expect(await page.content()).toBe(before);
    } finally {
      await page.close();
    }
  });
  it("rejects foreign paint revealed during readback and preserves that authored edit", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      await page.evaluate(() => {
        const foreign = document.createElement("div");
        foreign.id = "late-foreign";
        foreign.style.cssText = "position:absolute;left:40px;top:0;width:8px;height:8px;background:green";
        document.body.appendChild(foreign);
      });
      const { prime, tree } = await nativeOwner(page);
      const original = page.screenshot.bind(page);
      const screenshot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
        await page
          .locator("#late-foreign")
          .evaluate((element) => (element as HTMLElement).style.setProperty("visibility", "visible", "important"));
        return original(options);
      });
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("foreign paint changed during screenshot");
      } finally {
        screenshot.mockRestore();
        await prime.dispose();
      }
      expect(
        await page.locator("#late-foreign").evaluate((element) => ({
          value: (element as HTMLElement).style.visibility,
          priority: (element as HTMLElement).style.getPropertyPriority("visibility"),
        })),
      ).toEqual({ value: "visible", priority: "important" });
    } finally {
      await page.close();
    }
  });
  it("bounds a never-settling screenshot from Node and restores its isolation", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      const before = await page.content();
      const { prime, tree } = await nativeOwner(page);
      const screenshot = vi.spyOn(page, "screenshot").mockImplementation(() => new Promise<Buffer>(() => undefined));
      const started = performance.now();
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("native paint operation timed out");
        expect(performance.now() - started).toBeLessThan(8000);
      } finally {
        screenshot.mockRestore();
        await prime.dispose();
      }
      expect(await page.content()).toBe(before);
    } finally {
      await page.close();
    }
  }, 15_000);
  it("retains failed isolation cleanup, releases its hide sheet and retries safely", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      const before = await page.content();
      const { prime, tree } = await nativeOwner(page);
      const original = page.screenshot.bind(page);
      const screenshot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
        const shot = await original(options);
        await page.locator("#box").evaluate((element) => {
          const original = element.removeAttribute;
          Object.defineProperty(element, "removeAttribute", {
            configurable: true,
            value(name: string) {
              if (name.startsWith("data-__domotioncsspaint_")) throw new Error("controlled marker cleanup failure");
              original.call(this, name);
            },
          });
        });
        return shot;
      });
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("cleanup operations unconfirmed");
        await expect(prime.dispose()).rejects.toThrow("cleanup operations unconfirmed");
        expect(
          await page.evaluate((key) => {
            const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal;
            return { retained: state.isolation != null, sheetConnected: state.isolation?.sheet.isConnected };
          }, prime.registryKey),
        ).toEqual({ retained: true, sheetConnected: false });
      } finally {
        screenshot.mockRestore();
        await page.locator("#box").evaluate((element) => Reflect.deleteProperty(element, "removeAttribute"));
        await prime.dispose();
      }
      expect(await page.content()).toBe(before);
    } finally {
      await page.close();
    }
  });
  it("refuses navigation during native screenshot before accepting foreign document pixels", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/?csp=blocked`);
      const { prime, tree } = await nativeOwner(page);
      const original = page.screenshot.bind(page);
      const screenshot = vi.spyOn(page, "screenshot").mockImplementation(async (options) => {
        await page.goto(`${origin}/?kind=mask&csp=blocked`);
        return original(options);
      });
      try {
        await expect(prime.rasterize(tree, viewport)).rejects.toThrow("document changed");
      } finally {
        screenshot.mockRestore();
        await prime.dispose();
      }
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll("*")]
            .flatMap((element) => element.getAttributeNames())
            .some((name) => name.startsWith("data-__domotioncsspaint_")),
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });
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
  it.each(["clip", "mask"] as const)(
    "preserves native CSP-blocked %s paint without changing source or fetching bytes",
    async (kind) => {
      const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
      try {
        await page.goto(`${origin}/?kind=${kind}&csp=blocked`);
        const before = await pixels(page);
        const style = await page.locator("#box").getAttribute("style");
        await freezeRealWorldDom(page);
        const start = requests.length;
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 64, height: 64 }, {});
        expect(captured.warnings.some((warning) => warning.feature === "external-css-svg-raster")).toBe(true);
        const owner = captured.tree
          .flatMap((node) => [node, ...node.children])
          .find((node) => node.externalCssSvgRaster != null);
        expect(owner?.externalCssSvgRaster?.dataUri).toMatch(/^data:image\/png/);
        const output = await browser.newPage({ viewport: { width: 64, height: 64 } });
        try {
          await output.setContent(`<body style="margin:0">${elementTreeToSvg(captured.tree, 64, 64, {})}`);
          expect((await pixels(output)).equals(before)).toBe(true);
          const directory = join(
            process.env["DOMOTION_OUTPUT_DIR"] ??
              (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
            "external-svg-frozen",
            "css-fragments",
          );
          await mkdir(directory, { recursive: true });
          await Promise.all([
            writeFile(join(directory, `csp-${kind}-source.png`), await page.screenshot()),
            writeFile(join(directory, `csp-${kind}-captured.png`), await output.screenshot()),
            writeFile(
              join(directory, `csp-${kind}-evidence.json`),
              JSON.stringify(
                {
                  generatedAt: new Date().toISOString(),
                  sourceCommit: process.env["GITHUB_SHA"] ?? null,
                  platform: process.platform,
                  browser: browser.version(),
                  kind,
                  byteIdenticalPixels: true,
                  nativeOwner: owner?.externalCssSvgRaster,
                  extraRequests: requests.slice(start),
                },
                null,
                2,
              ),
            ),
          ]);
        } finally {
          await output.close();
        }
        expect(requests).toHaveLength(start);
        expect(await page.locator("#box").getAttribute("style")).toBe(style);
        expect((await pixels(page)).equals(before)).toBe(true);
        expect(await page.locator('svg [id^="__domotionCssSvgDefinition_"]').count()).toBe(0);
      } finally {
        await page.close();
      }
    },
  );
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
      const prime = await primeExternalCssSvgReferences(page);
      try {
        expect(
          await page.evaluate(
            (key) =>
              ((globalThis as Record<string, unknown>)[key] as { rasterOwners: Map<Element, unknown> }).rasterOwners
                .size,
            prime.registryKey,
          ),
        ).toBe(1);
      } finally {
        await prime.dispose();
      }
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
