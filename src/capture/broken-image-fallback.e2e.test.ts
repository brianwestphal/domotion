import { afterAll, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { captureElementTreeWithWarnings, launchChromium } from "./index.js";
import { captureBrokenImageFallbackFacts } from "./broken-image-fallback.js";
import type { CapturedElement, CaptureWarning } from "./types.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

const BROKEN = "data:image/png;base64,AAAA";
const GOOD = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

interface Seed {
  id: string;
  sourceNodeIndex: number;
  effectiveZoom: number;
  hostRect: { x: number; y: number; width: number; height: number };
  source: {
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    currentSrc: string;
    src: { present: boolean; value: string | null };
    alt: { present: boolean; value: string | null };
    title: { present: boolean; value: string | null };
    resolvedText: string;
  };
}

function elements(seeds: Seed[]): CapturedElement[] {
  return seeds.map((seed) => ({
    tag: "img",
    x: seed.hostRect.x,
    y: seed.hostRect.y,
    width: seed.hostRect.width,
    height: seed.hostRect.height,
    children: [],
    brokenImageFallback: {
      schemaVersion: 1,
      authority: "chromium-ua-shadow-v1",
      sourceNodeIndex: seed.sourceNodeIndex,
      effectiveZoom: seed.effectiveZoom,
      selector: `#${seed.id}`,
      hostRect: seed.hostRect,
      source: seed.source,
    },
  } as unknown as CapturedElement));
}

async function captureLiveImages(
  page: Page,
  registry: string,
  viewport: { x: number; y: number; width: number; height: number },
): Promise<{
  seeds: Seed[];
  captured: CapturedElement[];
  byId: Map<string, NonNullable<CapturedElement["brokenImageFallback"]>>;
  warnings: CaptureWarning[];
}> {
  const seeds = await page.evaluate(({ key, viewport }) => {
    const images = Array.from(document.images);
    (globalThis as typeof globalThis & Record<string, unknown>)[key] = images;
    return images.map((image, sourceNodeIndex) => {
      const rect = image.getBoundingClientRect();
      const present = (name: "src" | "alt" | "title") => ({
        present: image.hasAttribute(name),
        value: image.hasAttribute(name) ? image.getAttribute(name) : null,
      });
      const alt = present("alt");
      const title = present("title");
      return {
        id: image.id,
        sourceNodeIndex,
        effectiveZoom: Number.parseFloat(getComputedStyle(image).zoom) || 1,
        hostRect: {
          x: rect.x - viewport.x,
          y: rect.y - viewport.y,
          width: rect.width,
          height: rect.height,
        },
        source: {
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          currentSrc: image.currentSrc,
          src: present("src"),
          alt,
          title,
          resolvedText: alt.present ? (alt.value ?? "") : title.present ? (title.value ?? "") : "",
        },
      };
    });
  }, { key: registry, viewport }) as Seed[];
  const captured = elements(seeds);
  const warnings: CaptureWarning[] = [];
  await captureBrokenImageFallbackFacts(page, captured, viewport, warnings, registry);
  return {
    seeds,
    captured,
    warnings,
    byId: new Map(seeds.map((seed, index) => [seed.id, captured[index].brokenImageFallback!])),
  };
}

describeBrowser("Chromium broken-image UA-shadow capture (DM-2463)", () => {
  for (const dpr of [1, 2]) {
    it(`captures source-owned layout/text/font/AX facts at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({
        viewport: { width: 760, height: 500 },
        deviceScaleFactor: dpr,
      });
      const page = await context.newPage();
      const registry = `__dm2463_${dpr}`;
      try {
        await page.setContent(`<!doctype html><style>
          html,body{margin:0} img{position:absolute;font:italic 700 20px/28px Georgia,serif;color:rgb(17,34,51)}
          #text{left:10px;top:10px}
          #title{left:10px;top:55px}
          #empty{left:10px;top:100px}
          #missing{left:10px;top:130px}
          #small{left:10px;top:175px;width:17px;height:17px}
          #threshold{left:50px;top:175px;width:18px;height:18px}
          #rtl{left:100px;top:175px;direction:rtl}
          #vertical{left:250px;top:10px;width:72px;height:180px;writing-mode:vertical-rl}
          #zoom{left:360px;top:10px;zoom:1.5}
          #good{left:10px;top:230px;width:20px;height:20px}
          #nosrc{left:50px;top:230px}
        </style>
        <img id="text" src="${BROKEN}" alt="A😀ב alternative">
        <img id="title" src="${BROKEN}" title="Title fallback">
        <img id="empty" src="${BROKEN}" alt="">
        <img id="missing" src="${BROKEN}">
        <img id="small" src="${BROKEN}" alt="">
        <img id="threshold" src="${BROKEN}" alt="">
        <img id="rtl" src="${BROKEN}" alt="مرحبا">
        <img id="vertical" src="${BROKEN}" alt="vertical">
        <img id="zoom" src="${BROKEN}" alt="zoomed">
        <img id="good" src="${GOOD}" alt="successful">
        <img id="nosrc" alt="no source">`, { waitUntil: "load" });
        const { byId, warnings } = await captureLiveImages(
          page,
          registry,
          { x: 0, y: 0, width: 760, height: 500 },
        );

        expect(warnings).toEqual([]);
        expect(byId.get("text")).toMatchObject({
          disposition: "non-replaced-fallback",
          captureStatus: "exact",
          paintOwnership: "hybrid-icon-raster-vector-text",
          source: { alt: { present: true }, title: { present: false }, resolvedText: "A😀ב alternative" },
          icon: { visible: true, cssWidth: 16, cssHeight: 16, resourceScale: dpr === 1 ? 1 : 2 },
          text: { value: "A😀ב alternative" },
          accessibility: { ignored: false, role: "image", name: "A😀ב alternative" },
        });
        const text = byId.get("text")!.text!;
        expect(text.fontMetrics.ascent).toBeGreaterThan(0);
        expect(text.segments).not.toHaveLength(0);
        expect(text.resolvedFonts).not.toHaveLength(0);
        expect(text.codepoints.map(({ text }) => text)).toEqual(Array.from("A😀ב alternative"));
        expect(text.codepoints.find(({ text }) => text === "😀")).toMatchObject({ start: 1, end: 3 });

        expect(byId.get("title")).toMatchObject({
          disposition: "non-replaced-fallback",
          source: { alt: { present: false }, title: { present: true }, resolvedText: "Title fallback" },
          accessibility: { ignored: false, role: "image", name: "Title fallback" },
        });
        expect(byId.get("empty")).toMatchObject({
          disposition: "empty-inline",
          paintOwnership: "none",
          icon: { visible: false },
          accessibility: { ignored: true },
        });
        expect(byId.get("missing")).toMatchObject({
          disposition: "non-replaced-fallback",
          icon: { visible: true },
          source: { alt: { present: false }, resolvedText: "" },
          accessibility: { ignored: false, role: "image" },
        });
        expect(byId.get("small")).toMatchObject({
          disposition: "replaced-flow-root-fallback",
          icon: { visible: false },
          container: { display: "flow-root", border: { top: 0 }, padding: { top: 0 } },
        });
        expect(byId.get("threshold")).toMatchObject({
          disposition: "replaced-flow-root-fallback",
          icon: { visible: true },
          container: { display: "flow-root", overflowX: "hidden", border: { top: dpr > 0 ? 1 : 1 }, padding: { top: 1 } },
        });
        expect(byId.get("rtl")).toMatchObject({
          container: { direction: "rtl" },
          icon: { float: "right", visible: true },
          text: { style: { direction: "rtl" } },
        });
        expect(byId.get("vertical")).toMatchObject({
          container: { writingMode: "vertical-rl" },
          text: { style: { writingMode: "vertical-rl" } },
        });
        expect(byId.get("vertical")!.text!.segments[0].verticalWritingMode).toBe("vertical-rl");
        expect(byId.get("zoom")).toMatchObject({
          container: { effectiveZoom: 1.5 },
          icon: { visible: true },
        });
        expect(byId.get("zoom")!.icon!.box!.rect.width).toBeCloseTo(24, 3);
        expect(byId.get("good")).toMatchObject({
          disposition: "primary",
          loadState: "loaded",
          paintOwnership: "none",
        });
        expect(byId.get("good")!.container).toBeUndefined();
        expect(byId.get("nosrc")).toMatchObject({
          disposition: "non-replaced-fallback",
          loadState: "no-source",
          source: { src: { present: false }, resolvedText: "no source" },
          paintOwnership: "hybrid-icon-raster-vector-text",
        });
      } finally {
        await page.evaluate((key) => { delete (globalThis as typeof globalThis & Record<string, unknown>)[key]; }, registry).catch(() => {});
        await context.close();
      }
    }, 60_000);
  }

  it("crosses standards/quirks sizing, source, author-box, and loading/error states", async () => {
    const context = await env!.browser.newContext({
      viewport: { width: 900, height: 560 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const keys: string[] = [];
    try {
      const standardsKey = "__dm2463_standards";
      keys.push(standardsKey);
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}img{display:block;margin:6px;font:16px/20px sans-serif}
        #author{border:3px solid rgb(1,2,3);padding:4px 5px 6px 7px;background:rgb(9,8,7)}
        #long{max-width:84px;overflow:hidden;white-space:nowrap}
      </style>
      <img id="std-one-text" src="${BROKEN}" width="70" alt="one dimension text">
      <img id="std-both-text" src="${BROKEN}" width="70" height="30" alt="both dimensions text">
      <img id="std-one-empty" src="${BROKEN}" width="70" alt="">
      <img id="std-both-empty" src="${BROKEN}" width="70" height="30" alt="">
      <img id="std-ratio-empty" src="${BROKEN}" style="width:70px;aspect-ratio:2/1" alt="">
      <img id="std-zero" src="${BROKEN}" width="0" height="0" alt="">
      <img id="empty-src" src="" alt="">
      <img id="valueless-src" src alt="">
      <img id="author" src="${BROKEN}" alt="author box">
      <img id="long" src="${BROKEN}" alt="a very long alternative label that must retain physical range geometry">`, { waitUntil: "load" });
      const standards = await captureLiveImages(
        page,
        standardsKey,
        { x: 0, y: 0, width: 900, height: 560 },
      );
      expect(standards.warnings).toEqual([]);
      expect(standards.byId.get("std-one-text")?.disposition).toBe("non-replaced-fallback");
      expect(standards.byId.get("std-both-text")?.disposition).toBe("non-replaced-fallback");
      expect(standards.byId.get("std-one-empty")?.disposition).toBe("empty-inline");
      expect(standards.byId.get("std-both-empty")?.disposition).toBe("replaced-flow-root-fallback");
      expect(standards.byId.get("std-ratio-empty")?.disposition).toBe("replaced-flow-root-fallback");
      expect(standards.byId.get("std-zero")).toMatchObject({
        disposition: "replaced-flow-root-fallback",
        icon: { visible: false },
      });
      expect(standards.byId.get("empty-src")).toMatchObject({
        disposition: "empty-inline",
        source: { src: { present: true, value: "" } },
        paintOwnership: "none",
      });
      expect(standards.byId.get("valueless-src")).toMatchObject({
        disposition: "empty-inline",
        source: { src: { present: true, value: "" } },
        paintOwnership: "none",
      });
      const author = standards.byId.get("author")!;
      expect(author.hostBox).not.toBeNull();
      // The source-owned host box preserves the author border/padding planes;
      // it is not reconstructed from the fallback child or its icon.
      expect(author.hostBox!.border[0]).toBeLessThan(author.hostBox!.padding[0]);
      expect(author.hostBox!.padding[0]).toBeLessThan(author.hostBox!.content[0]);
      expect(author.hostBox!.content[1] - author.hostBox!.padding[1]).toBeCloseTo(4, 3);
      const long = standards.byId.get("long")!.text!;
      expect(long.value).toContain("very long alternative");
      expect(long.codepoints).toHaveLength(Array.from(long.value).length);
      expect(long.box!.width).toBeGreaterThan(84);

      const quirksKey = "__dm2463_quirks";
      keys.push(quirksKey);
      await page.setContent(`<style>html,body{margin:0}img{display:block;margin:8px;font:16px/20px sans-serif}#quirks-both{white-space:nowrap}</style>
        <img id="quirks-one" src="${BROKEN}" width="70" alt="one dimension becomes replaced in quirks">
        <img id="quirks-both" src="${BROKEN}" width="100" height="28" alt="long clipped alternative text">
        <img id="quirks-ratio" src="${BROKEN}" style="width:90px;aspect-ratio:3/1" alt="ratio text">`, { waitUntil: "load" });
      expect(await page.evaluate(() => document.compatMode)).toBe("BackCompat");
      const quirks = await captureLiveImages(
        page,
        quirksKey,
        { x: 0, y: 0, width: 900, height: 560 },
      );
      expect(quirks.warnings).toEqual([]);
      for (const id of ["quirks-one", "quirks-both", "quirks-ratio"]) {
        expect(quirks.byId.get(id)?.disposition).toBe("replaced-flow-root-fallback");
        expect(quirks.byId.get(id)?.container).toMatchObject({
          display: "flow-root",
          overflowX: "hidden",
          overflowY: "hidden",
        });
      }
      expect(quirks.byId.get("quirks-both")!.text!.box!.width).toBeGreaterThan(
        quirks.byId.get("quirks-both")!.container!.box!.rect.width,
      );

      let loadingRoute: import("@playwright/test").Route | undefined;
      await page.route("https://slow.example.test/slow.png", (route) => { loadingRoute = route; });
      await page.setContent("<!doctype html><body></body>", { waitUntil: "load" });
      await page.evaluate(() => {
        const image = document.createElement("img");
        image.id = "loading";
        image.alt = "pending";
        image.src = "https://slow.example.test/slow.png";
        document.body.append(image);
      });
      await page.waitForFunction(() => document.images.length === 1 && !document.images[0].complete);
      const loadingKey = "__dm2463_loading";
      keys.push(loadingKey);
      const loading = await captureLiveImages(
        page,
        loadingKey,
        { x: 0, y: 0, width: 900, height: 560 },
      );
      expect(loading.warnings).toEqual([]);
      expect(loading.byId.get("loading")).toMatchObject({
        disposition: "loading",
        captureStatus: "exact",
        loadState: "loading",
        paintOwnership: "none",
      });
      await loadingRoute?.abort().catch(() => {});

      const collapsedKey = "__dm2463_collapsed";
      keys.push(collapsedKey);
      // A DevTools-blocked request remains an ordinary fallback in stock
      // Chromium. The no-shadow collapse-initiator branch is covered by the
      // pure source-state test because browser embedder policy owns that bit.
      const blocker = await context.newCDPSession(page);
      await blocker.send("Network.enable");
      await blocker.send("Network.setBlockedURLs", { urls: ["https://blocked.example.test/*"] });
      await page.setContent(`<!doctype html><img id="collapsed" src="https://blocked.example.test/image.png" alt="blocked">`, { waitUntil: "load" });
      const collapsed = await captureLiveImages(
        page,
        collapsedKey,
        { x: 0, y: 0, width: 900, height: 560 },
      );
      expect(collapsed.warnings).toEqual([]);
      expect(collapsed.byId.get("collapsed")).toMatchObject({
        disposition: "non-replaced-fallback",
        captureStatus: "exact",
        loadState: "failed",
        paintOwnership: "hybrid-icon-raster-vector-text",
      });
      await blocker.detach();
    } finally {
      for (const key of keys) {
        await page.evaluate((value) => {
          delete (globalThis as typeof globalThis & Record<string, unknown>)[value];
        }, key).catch(() => {});
      }
      await context.close();
    }
  }, 60_000);

  it("enriches the synchronous capture tree before releasing live-node correlation", async () => {
    const page = await env!.browser.newPage({
      viewport: { width: 420, height: 240 },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}img{display:block;margin:8px;font:18px/24px sans-serif}
      </style>
      <img src="${BROKEN}" alt="pipeline text">
      <img src="${BROKEN}" alt="">
      <img src="${BROKEN}" width="18" height="18" alt="">
      <img src="${GOOD}" width="20" height="20" alt="successful">
      <img title="title without source">`, { waitUntil: "load" });

      const result = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 420, height: 240 },
      );
      const walk = (nodes: CapturedElement[]): CapturedElement[] =>
        nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
      const records = walk(result.tree)
        .filter((node) => node.tag === "img")
        .map((node) => node.brokenImageFallback);

      // Zero-sized empty/no-source hosts remain represented so their source
      // and AX state cannot collapse into the legacy `imageBroken` boolean.
      expect(records).toHaveLength(5);
      expect(records.map((record) => record?.disposition)).toEqual([
        "non-replaced-fallback",
        "empty-inline",
        "replaced-flow-root-fallback",
        "primary",
        "non-replaced-fallback",
      ]);
      expect(records.every((record) => record?.captureStatus === "exact")).toBe(true);
      expect(records[0]?.text?.segments).not.toHaveLength(0);
      expect(records[1]?.paintOwnership).toBe("none");
      expect(records[2]?.icon?.visible).toBe(true);
      expect(records[3]?.container).toBeUndefined();
      expect(records[4]?.source).toMatchObject({
        src: { present: false },
        alt: { present: false },
        title: { present: true, value: "title without source" },
        resolvedText: "title without source",
      });
      expect(records.some((record) => record?.sourceNodeIndex != null || record?.selector != null)).toBe(false);
      expect(result.warnings.filter(({ feature }) => feature === "broken-image-fallback")).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
