import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openExternalSvgTransport } from "../src/capture/external-svg-transport.js";
import { primeExternalSvgUseDocuments } from "../src/capture/external-svg-use.js";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";

const sprite = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- original Unicode: ☃ &amp; spacing -->\n<symbol id="s" viewBox="0 0 32 32"><rect width="32" height="32" fill="${fill}"/></symbol>\n</svg>\n`;
const html = (href = "/sprite.svg#s") =>
  `<!doctype html><body style="margin:0;background:white"><svg width="32" height="32" style="display:block"><use href="${href}"/></svg>`;
let browser: Browser;
let server: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let directory: string;
const requests: Array<{ path: string; dest: string; cookie: string; foreign: boolean; closed: boolean }> = [];
const evidence: Array<Record<string, unknown>> = [];

async function serve(foreign: boolean): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    const fact = {
      path,
      dest: String(request.headers["sec-fetch-dest"] ?? ""),
      cookie: request.headers.cookie ?? "",
      foreign,
      closed: false,
    };
    requests.push(fact);
    response.once("close", () => {
      fact.closed = true;
    });
    if (path.startsWith("/redirect-")) {
      response.writeHead(302, { location: `${otherOrigin}/${path.includes("denied") ? "nocors.svg" : "sprite.svg"}` });
      response.end();
    } else if (path.endsWith(".svg")) {
      response.setHeader("content-type", "image/svg+xml");
      if (foreign && path !== "/nocors.svg") response.setHeader("access-control-allow-origin", "*");
      if (path === "/stalled.svg") {
        response.write('<svg xmlns="http://www.w3.org/2000/svg">');
        return;
      }
      response.end(path === "/malformed.svg" ? "<svg><bad></svg>" : sprite(foreign ? "blue" : "red"));
    } else {
      response.setHeader("content-type", "text/html");
      if (path === "/blocked") response.setHeader("content-security-policy", "connect-src 'none'");
      response.end(html(path === "/stalled" ? "/stalled.svg#s" : "/sprite.svg#s"));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("SVG fixture did not bind");
  return { server, origin: `http://${foreign ? "localhost" : "127.0.0.1"}:${address.port}` };
}
async function rows(page: Page, key: string) {
  return page.evaluate(
    (key) =>
      Array.from(
        (
          globalThis as typeof globalThis & Record<string, Map<string, { document: Document | null; failure?: string }>>
        )[key] ?? [],
        ([href, entry]) => ({
          href,
          failure: entry.failure,
          xml: entry.document == null ? null : new XMLSerializer().serializeToString(entry.document),
        }),
      ),
    key,
  );
}
async function pixel(png: Buffer): Promise<number[]> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (16 * info.width + 16) * info.channels;
  return [...data.subarray(at, at + 3)];
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dm-external-svg-frozen-"));
  ({ server, origin } = await serve(false));
  ({ server: other, origin: otherOrigin } = await serve(true));
  browser = await chromium.launch();
});
afterAll(async () => {
  await closeBrowserSafely(browser, 15_000);
  await Promise.all([server, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(directory, { recursive: true, force: true });
});

describe("external SVG transport under frozen author globals (DM-4H5MC1)", () => {
  it("captures the same red vector after freezing without replacing author globals", async () => {
    const context = await browser.newContext({ viewport: { width: 64, height: 64 } });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const before = await page.screenshot();
      expect(await pixel(before)).toEqual([255, 0, 0]);
      expect(await freezeRealWorldDom(page)).toBe(true);
      await page.evaluate(() => {
        (globalThis as typeof globalThis & { frozenIdentity?: unknown }).frozenIdentity = {
          fetch,
          timer: setTimeout,
          raf: requestAnimationFrame,
        };
      });
      const start = Date.now();
      const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 64, height: 64 }, {});
      expect(Date.now() - start).toBeLessThan(5000);
      const svg = elementTreeToSvg(captured.tree, 64, 64, {});
      expect(svg).toContain("domotion-external-use");
      expect(svg).toContain("<rect");
      expect(svg).not.toContain("<use");
      expect(captured.warnings.filter((w) => w.feature === "inline-svg")).toEqual([]);
      expect(
        await page.evaluate(() => {
          const saved = (
            globalThis as typeof globalThis & {
              frozenIdentity: { fetch: typeof fetch; timer: typeof setTimeout; raf: typeof requestAnimationFrame };
            }
          ).frozenIdentity;
          return saved.fetch === fetch && saved.timer === setTimeout && saved.raf === requestAnimationFrame;
        }),
      ).toBe(true);
      const rendered = await context.newPage();
      await rendered.setContent(`<body style="margin:0">${svg}`);
      const after = await rendered.screenshot();
      expect(await pixel(after)).toEqual([255, 0, 0]);
      const a = await sharp(before).removeAlpha().raw().toBuffer();
      const b = await sharp(after).removeAlpha().raw().toBuffer();
      expect(a.equals(b)).toBe(true);
      const output =
        process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output");
      const path = join(output, "external-svg-frozen");
      await mkdir(path, { recursive: true });
      await Promise.all([writeFile(join(path, "source.png"), before), writeFile(join(path, "captured.png"), after)]);
      const session = await context.newCDPSession(page);
      const version = await session.send("Browser.getVersion");
      await session.detach();
      evidence.push({
        case: "frozen-vector",
        generatedAt: new Date().toISOString(),
        sourceCommit: process.env["GITHUB_SHA"] ?? null,
        browser: version,
        sourcePixel: await pixel(before),
        capturedPixel: await pixel(after),
        byteIdenticalPixels: true,
        svgSha256: createHash("sha256").update(svg).digest("hex"),
      });
      await writeFile(join(path, "evidence.json"), JSON.stringify(evidence, null, 2));
    } finally {
      await context.close();
    }
  });

  it("retains cookie credentials, exact source XML and one owned session for concurrent documents", async () => {
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: "control", value: "same-origin-cookie", url: origin }]);
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => {
        document.body.innerHTML += '<svg><use href="/second.svg#s"/></svg>';
      });
      await freezeRealWorldDom(page);
      const sessions = vi.spyOn(context, "newCDPSession");
      const start = requests.length;
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        const result = await rows(page, prime.registryKey);
        expect(result).toHaveLength(2);
        expect(result.every((row) => row.xml?.includes('fill="red"'))).toBe(true);
        expect(sessions).toHaveBeenCalledTimes(1);
        expect(
          requests
            .slice(start)
            .filter((r) => r.dest === "empty")
            .map((r) => r.cookie),
        ).toEqual(["control=same-origin-cookie", "control=same-origin-cookie"]);
      } finally {
        sessions.mockRestore();
        await prime.dispose();
      }
      const exact = await openExternalSvgTransport(page.mainFrame(), 5000);
      try {
        expect(await exact.fetch(`${origin}/sprite.svg`)).toEqual({ text: sprite("red"), hrefs: [] });
      } finally {
        await exact.dispose();
      }
      expect(
        await page.evaluate(() =>
          Object.getOwnPropertyNames(globalThis).filter((name) => /^__domotionExternalSvg(?:Frame|Use)_/.test(name)),
        ),
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("preserves connect-src refusal instead of acquiring isolated-world privileges", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/blocked`);
      await freezeRealWorldDom(page);
      const start = requests.length;
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        expect(await rows(page, prime.registryKey)).toMatchObject([
          { failure: expect.stringMatching(/Failed to fetch/) },
        ]);
      } finally {
        await prime.dispose();
      }
      expect(requests.slice(start).filter((r) => r.dest === "empty")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("refuses direct foreign SVG even with CORS permission, while preserving redirect CORS behavior", async () => {
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: "control", value: "origin-only-cookie", url: origin }]);
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate((foreign) => {
        document.body.innerHTML = `<svg><use href="${foreign}/sprite.svg#s"/><use href="/redirect-ok.svg#s"/><use href="/redirect-denied.svg#s"/></svg>`;
      }, otherOrigin);
      await freezeRealWorldDom(page);
      const start = requests.length;
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        const result = await rows(page, prime.registryKey);
        expect(result.find((row) => row.href === `${otherOrigin}/sprite.svg`)).toMatchObject({
          failure: expect.stringMatching(/not same-origin/),
        });
        expect(result.find((row) => row.href === `${origin}/redirect-ok.svg`)?.xml).toContain('fill="blue"');
        expect(result.find((row) => row.href === `${origin}/redirect-denied.svg`)).toMatchObject({
          failure: expect.stringMatching(/Failed to fetch/),
        });
        const foreignFetches = requests.slice(start).filter((r) => r.foreign && r.dest === "empty");
        expect(foreignFetches.map((r) => r.path).sort()).toEqual(["/nocors.svg", "/sprite.svg"]);
        expect(foreignFetches.every((r) => r.cookie === "")).toBe(true);
      } finally {
        await prime.dispose();
      }
    } finally {
      await context.close();
    }
  });

  it("bounds a stalled response body with Node time and aborts only the owned fetch", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/stalled`, { waitUntil: "domcontentloaded" });
      await freezeRealWorldDom(page);
      const start = Date.now();
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        expect(await rows(page, prime.registryKey)).toMatchObject([{ failure: "the fetch timed out" }]);
        expect(Date.now() - start).toBeGreaterThanOrEqual(5000);
        expect(Date.now() - start).toBeLessThan(6500);
        await expect
          .poll(() => requests.filter((r) => r.path === "/stalled.svg" && r.dest === "empty").every((r) => r.closed))
          .toBe(true);
        expect(requests.some((r) => r.path === "/stalled.svg" && r.dest === "image" && !r.closed)).toBe(true);
      } finally {
        await prime.dispose();
      }
    } finally {
      await context.close();
    }
  });

  it("uses renderer HAR routing during frozen replay without contacting the network", async () => {
    const harPath = join(directory, "sprite.har");
    const record = await browser.newContext({
      recordHar: { path: harPath, content: "embed" },
      serviceWorkers: "block",
    });
    try {
      const page = await record.newPage();
      await page.goto(origin);
      await freezeRealWorldDom(page);
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        expect((await rows(page, prime.registryKey))[0].xml).toContain('fill="red"');
      } finally {
        await prime.dispose();
      }
    } finally {
      await record.close();
    }
    const har = JSON.parse(await readFile(harPath, "utf8"));
    expect(
      har.log.entries.some(
        (entry: { response: { content: { text?: string } } }) => entry.response.content.text === sprite("red"),
      ),
    ).toBe(true);
    const replay = await browser.newContext({ serviceWorkers: "block" });
    try {
      await replay.routeFromHAR(harPath, { notFound: "abort" });
      let fetchRoutes = 0;
      await replay.route("**/*", async (route) => {
        if (route.request().resourceType() === "fetch") fetchRoutes++;
        await route.fallback();
      });
      const start = requests.length;
      const page = await replay.newPage();
      await page.goto(origin);
      await freezeRealWorldDom(page);
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        expect((await rows(page, prime.registryKey))[0].xml).toContain('fill="red"');
      } finally {
        await prime.dispose();
      }
      expect(fetchRoutes).toBe(1);
      expect(requests.length).toBe(start);
    } finally {
      await replay.close();
    }
  });

  it("authenticates identical child URLs and OOPIF origins while leaving another context untouched", async () => {
    const owned = await chromium.launch({ args: ["--site-per-process"] });
    const context = await owned.newContext();
    const foreign = await owned.newContext();
    try {
      const page = await context.newPage();
      const unrelated = await foreign.newPage();
      await unrelated.goto(origin);
      await page.goto(origin);
      await page.evaluate((otherOrigin) => {
        document.body.innerHTML += `<iframe src="/child"></iframe><iframe src="/child"></iframe><iframe src="${otherOrigin}/child"></iframe>`;
      }, otherOrigin);
      await expect.poll(() => page.frames().filter((frame) => frame.url().endsWith("/child")).length).toBe(3);
      for (const frame of page.frames()) await frame.waitForLoadState("load");
      const oopif = page.frames().find((frame) => frame.url().startsWith(otherOrigin))!;
      const actual = await context.newCDPSession(oopif);
      await actual.detach();
      await freezeRealWorldDom(page);
      for (const frame of page.frames().slice(1))
        await frame.evaluate(() => {
          window.fetch = (() => new Promise(() => {})) as typeof fetch;
          window.setTimeout = (() => 0) as unknown as typeof setTimeout;
        });
      const prime = await primeExternalSvgUseDocuments(page);
      try {
        for (const frame of page.frames()) {
          const colors = await frame.evaluate(
            (key) =>
              [
                ...(globalThis as typeof globalThis & Record<string, Map<string, { document: Document }>>)[
                  key
                ].values(),
              ].map((entry) => entry.document.querySelector("rect")?.getAttribute("fill")),
            prime.registryKey,
          );
          expect(colors).toEqual([frame === oopif ? "blue" : "red"]);
        }
        expect(await unrelated.evaluate((key) => Reflect.has(globalThis, key), prime.registryKey)).toBe(false);
      } finally {
        await prime.dispose();
      }
    } finally {
      await context.close();
      await foreign.close();
      await closeBrowserSafely(owned, 15_000);
    }
  });
  it("rejects missing source identity and disposes its session without falling back to URL matching", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const session = await context.newCDPSession(page);
      const detach = vi.spyOn(session, "detach");
      const attach = vi.spyOn(context, "newCDPSession").mockResolvedValueOnce(session);
      const tag = vi.spyOn(page.mainFrame(), "evaluate").mockResolvedValueOnce(undefined);
      const start = requests.length;
      await expect(openExternalSvgTransport(page.mainFrame(), 5000)).rejects.toThrow(
        "source frame identity unavailable",
      );
      expect(detach).toHaveBeenCalledTimes(1);
      expect(requests.slice(start).filter((r) => r.dest === "empty")).toEqual([]);
      tag.mockRestore();
      attach.mockRestore();
      detach.mockRestore();
      expect(
        await page.evaluate(() =>
          Object.getOwnPropertyNames(globalThis).filter((key) => key.startsWith("__domotionExternalSvgFrame_")),
        ),
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await context.close();
    }
  });

  it("detaches an owned session which arrives after setup's Node deadline", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const session = await context.newCDPSession(page);
      const detach = vi.spyOn(session, "detach");
      let resolve: (value: typeof session) => void;
      const late = new Promise<typeof session>((done) => {
        resolve = done;
      });
      vi.spyOn(context, "newCDPSession").mockReturnValueOnce(late);
      await expect(openExternalSvgTransport(page.mainFrame(), 25)).rejects.toThrow("timed out");
      resolve!(session);
      await expect.poll(() => detach.mock.calls.length).toBe(1);
      expect(
        await page.evaluate(() =>
          Object.getOwnPropertyNames(globalThis).filter((key) => key.startsWith("__domotionExternalSvgFrame_")),
        ),
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await context.close();
    }
  });

  it("aborts in-flight owned requests on disposal without aborting the source image", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/stalled`, { waitUntil: "domcontentloaded" });
      await freezeRealWorldDom(page);
      const transport = await openExternalSvgTransport(page.mainFrame(), 5000);
      const start = requests.length;
      const request = transport.fetch(`${origin}/stalled.svg`);
      await expect.poll(() => requests.slice(start).some((r) => r.dest === "empty")).toBe(true);
      await transport.dispose();
      await transport.dispose();
      expect(await request).toMatchObject({ failure: expect.any(String) });
      await expect
        .poll(() =>
          requests
            .slice(start)
            .filter((r) => r.dest === "empty")
            .every((r) => r.closed),
        )
        .toBe(true);
      expect(requests.some((r) => r.path === "/stalled.svg" && r.dest === "image" && !r.closed)).toBe(true);
      const inspector = await context.newCDPSession(page);
      const worlds: number[] = [];
      inspector.on("Runtime.executionContextCreated", ({ context }) => {
        if (context.name.startsWith("__domotionExternalSvgTransport_")) worlds.push(context.id);
      });
      await inspector.send("Runtime.enable");
      expect(worlds).toHaveLength(1);
      const globals = await inspector.send("Runtime.evaluate", {
        contextId: worlds[0],
        expression:
          "Object.getOwnPropertyNames(globalThis).filter(key=>key.startsWith('__domotionExternalSvgRequest_'))",
        returnByValue: true,
      });
      expect(globals.result.value).toEqual([]);
      await inspector.detach();
    } finally {
      await context.close();
    }
  });
  it("removes an owned source token whose evaluation completes after the setup deadline", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const frame = page.mainFrame();
      const evaluate = frame.evaluate;
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let finished = false;
      vi.spyOn(frame, "evaluate").mockImplementationOnce((async (...args: Parameters<typeof frame.evaluate>) => {
        await gate;
        const value: unknown = await Reflect.apply(evaluate, frame, args);
        finished = true;
        return value;
      }) as typeof frame.evaluate);
      const attach = vi.spyOn(context, "newCDPSession");
      await expect(openExternalSvgTransport(frame, 25)).rejects.toThrow("timed out");
      release!();
      await expect.poll(() => finished).toBe(true);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.getOwnPropertyNames(globalThis).filter((key) => key.startsWith("__domotionExternalSvgFrame_")),
          ),
        )
        .toEqual([]);
      expect(attach).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await context.close();
    }
  });
  it("reports unconfirmed cancellation and preserves the controller instead of claiming cleanup succeeded", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/stalled`, { waitUntil: "domcontentloaded" });
      const session = await context.newCDPSession(page);
      const attach = vi.spyOn(context, "newCDPSession").mockResolvedValueOnce(session);
      const transport = await openExternalSvgTransport(page.mainFrame(), 5000);
      attach.mockRestore();
      const start = requests.length;
      const outcome = transport.fetch(`${origin}/stalled.svg`).then(
        (value) => value,
        (error: unknown) => error,
      );
      await expect.poll(() => requests.slice(start).some((r) => r.dest === "empty")).toBe(true);
      const send = vi.spyOn(session, "send").mockRejectedValueOnce(new Error("controlled cancellation refusal"));
      await expect(transport.dispose()).rejects.toThrow("1 external SVG cleanup operations unconfirmed");
      await expect(transport.dispose()).rejects.toThrow("1 external SVG cleanup operations unconfirmed");
      send.mockRestore();
      expect(await outcome).toBeInstanceOf(Error);
      const inspector = await context.newCDPSession(page);
      const worlds: number[] = [];
      inspector.on("Runtime.executionContextCreated", ({ context }) => {
        if (context.name.startsWith("__domotionExternalSvgTransport_")) worlds.push(context.id);
      });
      await inspector.send("Runtime.enable");
      const globals = await inspector.send("Runtime.evaluate", {
        contextId: worlds[0],
        expression:
          "Object.getOwnPropertyNames(globalThis).filter(key=>key.startsWith('__domotionExternalSvgRequest_'))",
        returnByValue: true,
      });
      expect(globals.result.value).toHaveLength(1);
      expect(requests.slice(start).some((r) => r.dest === "empty" && !r.closed)).toBe(true);
      await inspector.detach();
    } finally {
      vi.restoreAllMocks();
      await context.close();
    }
  });
  it("keeps separate source origins for same-site cross-origin frame worlds without CORS permission", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const childOrigin = otherOrigin.replace("localhost", "127.0.0.1");
      await page.evaluate((url) => {
        const iframe = document.createElement("iframe");
        iframe.src = url;
        document.body.append(iframe);
      }, `${childOrigin}/child`);
      await expect.poll(() => page.frames().find((frame) => frame.url().startsWith(childOrigin))).toBeDefined();
      const child = page.frames().find((frame) => frame.url().startsWith(childOrigin))!;
      await child.waitForLoadState("load");
      const parentTransport = await openExternalSvgTransport(page.mainFrame(), 5000);
      const childTransport = await openExternalSvgTransport(child, 5000);
      try {
        // Neither server sends CORS permission for this path. If one world's
        // origin were borrowed by the other, these same-origin reads fail.
        expect(await parentTransport.fetch(`${origin}/nocors.svg`)).toEqual({ text: sprite("red"), hrefs: [] });
        expect(await childTransport.fetch(`${childOrigin}/nocors.svg`)).toEqual({ text: sprite("blue"), hrefs: [] });
      } finally {
        await parentTransport.dispose();
        await childTransport.dispose();
      }
    } finally {
      await context.close();
    }
  });
  it("refuses setup if its owned frame token cannot be removed and still detaches the session", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const original = context.newCDPSession.bind(context);
      let detached = 0;
      vi.spyOn(context, "newCDPSession").mockImplementationOnce(async (target) => {
        await page.evaluate(() => {
          const key = Object.getOwnPropertyNames(globalThis).find((name) =>
            name.startsWith("__domotionExternalSvgFrame_"),
          );
          if (key == null) throw new Error("Fixture source token missing");
          Object.defineProperty(globalThis, key, { configurable: false });
        });
        const session = await original(target);
        const detach = session.detach.bind(session);
        vi.spyOn(session, "detach").mockImplementation(async () => {
          detached++;
          await detach();
        });
        return session;
      });
      await expect(openExternalSvgTransport(page.mainFrame(), 5000)).rejects.toThrow(
        "external SVG setup and cleanup failed",
      );
      expect(detached).toBe(1);
      expect(
        await page.evaluate(() =>
          Object.getOwnPropertyNames(globalThis).filter((key) => key.startsWith("__domotionExternalSvgFrame_")),
        ),
      ).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await context.close();
    }
  });
  it("refuses a same-process navigation after token match and permits a fresh stable-document lease", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.src = "/child";
        document.body.append(frame);
      });
      await expect.poll(() => page.frames().find((frame) => frame !== page.mainFrame())).toBeDefined();
      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      await child.waitForLoadState("load");
      let sameProcessRefusal = false;
      let matched = false;
      let navigated = false;
      const attach = context.newCDPSession.bind(context);
      vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
        let session: Awaited<ReturnType<typeof attach>>;
        try {
          session = await attach(target);
        } catch (error) {
          if (target === child && /part of the parent frame|does not have a separate CDP session/i.test(String(error)))
            sameProcessRefusal = true;
          throw error;
        }
        const send = session.send.bind(session);
        vi.spyOn(session, "send").mockImplementation((async (...args: Parameters<typeof session.send>) => {
          const [method, params] = args;
          if (method === "Page.createIsolatedWorld" && !navigated) {
            expect(matched).toBe(true);
            navigated = true;
            await child.goto(`${origin}/after-navigation`);
          }
          const response: unknown = await Reflect.apply(send, session, args);
          const expression: unknown =
            params != null && typeof params === "object" ? Reflect.get(params, "expression") : undefined;
          if (
            method === "Runtime.evaluate" &&
            typeof expression === "string" &&
            expression.includes("===") &&
            (response as { result?: { value?: unknown } }).result?.value === true
          )
            matched = true;
          return response;
        }) as typeof session.send);
        return session;
      });
      const start = requests.length;
      await expect(
        (async () => {
          const transport = await openExternalSvgTransport(child, 5000);
          try {
            await transport.fetch(`${origin}/old-document.svg`);
          } finally {
            await transport.dispose();
          }
        })(),
      ).rejects.toThrow("source document identity unavailable after isolated world setup");
      expect(sameProcessRefusal).toBe(true);
      expect(matched).toBe(true);
      expect(navigated).toBe(true);
      expect(requests.slice(start).filter((request) => request.path === "/old-document.svg")).toEqual([]);
      vi.restoreAllMocks();
      const fresh = await openExternalSvgTransport(child, 5000);
      try {
        expect(await fresh.fetch(`${origin}/fresh-document.svg`)).toEqual({ text: sprite("red"), hrefs: [] });
      } finally {
        await fresh.dispose();
      }
      expect(
        await child.evaluate(() =>
          Object.getOwnPropertyNames(globalThis).filter(
            (key) => key.startsWith("__domotionExternalSvgFrame_") || key.startsWith("__domotionExternalSvgRequest_"),
          ),
        ),
      ).toEqual([]);
      const output =
        process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output");
      await mkdir(join(output, "external-svg-frozen"), { recursive: true });
      await writeFile(
        join(output, "external-svg-frozen", "navigation-guard.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            sourceCommit: process.env["GITHUB_SHA"] ?? null,
            browserVersion: browser.version(),
            sameProcessRefusal,
            defaultTokenMatched: matched,
            navigatedBeforeWorldCreation: navigated,
            oldDocumentAssetRequests: requests.slice(start).filter((request) => request.path === "/old-document.svg")
              .length,
            freshDocumentAssetRequests: requests
              .slice(start)
              .filter((request) => request.path === "/fresh-document.svg").length,
            rejectedBeforeFetch: true,
            freshStableDocumentRecovered: true,
          },
          null,
          2,
        ),
      );
    } finally {
      vi.restoreAllMocks();
      await context.close();
    }
  });
});
