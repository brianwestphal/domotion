import { afterAll, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "./index.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { captureBrokenImageFallbackFacts } from "./broken-image-fallback.js";
import type { CapturedElement, CaptureWarning } from "./types.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

const BROKEN = "data:image/png;base64,AAAA";
const GOOD =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
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
  return seeds.map(
    (seed) =>
      ({
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
      }) as unknown as CapturedElement,
  );
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
  const seeds = (await page.evaluate(
    ({ key, viewport }) => {
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
    },
    { key: registry, viewport },
  )) as Seed[];
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
    it.each([
      {
        name: "srcset only",
        markup: `<img id="test" srcset="${GOOD} 1x" alt="srcset only">`,
        src: { present: false, value: null },
      },
      {
        name: "empty src with srcset",
        markup: `<img id="test" src="" srcset="${GOOD} 1x" alt="srcset only">`,
        src: { present: true, value: "" },
      },
      {
        name: "srcset overrides failed src",
        markup: `<img id="test" src="${BROKEN}" srcset="${GOOD} 1x" alt="srcset only">`,
        src: { present: true, value: BROKEN },
      },
      {
        name: "picture without src",
        markup: `<picture><source srcset="${GOOD} 1x"><img id="test" alt="srcset only"></picture>`,
        src: { present: false, value: null },
      },
      {
        name: "picture overrides failed img candidates",
        markup: `<picture><source srcset="${GOOD} 1x"><img id="test" src="${BROKEN}" srcset="${BROKEN} 1x" alt="srcset only"></picture>`,
        src: { present: true, value: BROKEN },
      },
      {
        name: "unmatched picture falls back to img srcset",
        markup: `<picture><source media="not all" srcset="${BROKEN} 1x"><img id="test" srcset="${GOOD} 1x" alt="srcset only"></picture>`,
        src: { present: false, value: null },
      },
    ])(`renders selected $name at DPR ${dpr} (DM-E0KRM2)`, async ({ markup, src }) => {
      const context = await env!.browser.newContext({ viewport: { width: 140, height: 100 }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const generated = await context.newPage();
      try {
        await source.setContent(
          `<!doctype html><style>html,body{margin:0;background:white}img{display:block;width:64px;height:40px}</style>${markup}`,
        );
        await source.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        const expected = await source.screenshot();
        const capture = await captureElementTreeWithWarnings(source, "body", { x: 0, y: 0, width: 140, height: 100 });
        const walk = (nodes: CapturedElement[]): CapturedElement[] =>
          nodes.flatMap((node) => [node, ...walk(node.children)]);
        const image = walk(capture.tree).find((node) => node.tag === "img")!;
        expect(capture.warnings.filter((warning) => warning.feature === "broken-image-fallback")).toEqual([]);
        expect(image.imageSrc).toBe(GOOD);
        expect(image.brokenImageFallback).toMatchObject({
          disposition: "primary",
          loadState: "loaded",
          captureStatus: "exact",
          paintOwnership: "none",
          source: { complete: true, naturalWidth: 1, naturalHeight: 1, currentSrc: GOOD, src },
          hostBox: { rect: { x: 0, y: 0, width: 64, height: 40 } },
          accessibility: { ignored: false, role: "image", name: "srcset only" },
        });
        expect(image.brokenImageFallback?.container).toBeUndefined();
        expect(image.brokenImageFallback?.text).toBeUndefined();
        await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(capture.tree, 140, 100)}`);
        const native = await sharp(expected).ensureAlpha().raw().toBuffer();
        expect([...native.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
        expect(
          await sharp(await generated.screenshot())
            .ensureAlpha()
            .raw()
            .toBuffer(),
        ).toEqual(native);
      } finally {
        await context.close();
      }
    });
  }

  it("distinguishes pending/failed selections from absent candidates without src (DM-E0KRM2)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 700, height: 100 } });
    const routes: import("@playwright/test").Route[] = [];
    const registry = "__e0_responsive_states";
    try {
      await page.route("https://pending.example.test/*", (route) => {
        routes.push(route);
      });
      await page.setContent(
        `<!doctype html><img id="missing" alt="missing"><img id="empty" src="" alt="empty"><img id="empty-set" srcset="" alt="empty set"><picture><source media="not all" srcset="${GOOD}"><img id="no-match" alt="no match"></picture><img id="failed-set" srcset="${BROKEN} 1x" alt="failed set"><picture><source srcset="${BROKEN} 1x"><img id="failed-picture" alt="failed picture"></picture><img id="pending-set" srcset="https://pending.example.test/set.png 1x" alt="pending set"><picture><source srcset="https://pending.example.test/picture.png 1x"><img id="pending-picture" alt="pending picture"></picture>`,
        { waitUntil: "domcontentloaded" },
      );
      await expect.poll(() => routes.length).toBe(2);
      await page.waitForFunction(() => document.images[4].complete && document.images[5].complete);
      const capture = await captureLiveImages(page, registry, { x: 0, y: 0, width: 700, height: 100 });
      expect(capture.warnings).toEqual([]);
      for (const id of ["missing", "empty-set", "no-match"])
        expect(capture.byId.get(id)).toMatchObject({
          loadState: "no-source",
          source: { complete: true, currentSrc: "", src: { present: false } },
        });
      expect(capture.byId.get("empty")).toMatchObject({
        loadState: "failed",
        source: { complete: true, currentSrc: "", src: { present: true, value: "" } },
      });
      for (const id of ["failed-set", "failed-picture"])
        expect(capture.byId.get(id)).toMatchObject({
          disposition: "non-replaced-fallback",
          captureStatus: "exact",
          paintOwnership: "hybrid-icon-raster-vector-text",
          loadState: "failed",
          source: { complete: true, naturalWidth: 0, naturalHeight: 0, currentSrc: BROKEN, src: { present: false } },
        });
      for (const id of ["pending-set", "pending-picture"])
        expect(capture.byId.get(id)).toMatchObject({
          disposition: "loading",
          loadState: "loading",
          paintOwnership: "none",
          source: { complete: false, naturalWidth: 0, naturalHeight: 0, currentSrc: "", src: { present: false } },
        });
    } finally {
      for (const route of routes) await route.abort().catch(() => {});
      await page
        .evaluate((key) => {
          delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
        }, registry)
        .catch(() => {});
      await page.close();
    }
  });
  it("restores primary pixels after a broken image recovers and retains real fallback after relapse (DM-STQYYJ)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 140, height: 100 } });
    const generated = await env!.browser.newPage({ viewport: { width: 140, height: 100 } });
    try {
      for (const alt of ["", "loaded alternative"]) {
        await page.setContent(
          `<!doctype html><style>body{margin:0;background:white}img{display:block;width:64px;height:40px}</style><img src="${BROKEN}" alt="${alt}">`,
        );
        await page.waitForFunction(() => document.images[0].complete);
        const before = await captureLiveImages(page, "__stq", { x: 0, y: 0, width: 140, height: 100 });
        expect(before.warnings).toEqual([]);
        expect(before.captured[0].brokenImageFallback).toMatchObject({
          disposition: alt ? "non-replaced-fallback" : "replaced-flow-root-fallback",
          loadState: "failed",
          icon: { visible: true },
        });

        await page.locator("img").evaluate(async (image: HTMLImageElement, src) => {
          image.src = src;
          await image.decode();
        }, GOOD);
        // Changing the accessible alternative after recovery must not revive
        // stale UA text as paint. CSS content:none computes to normal here.
        await page.locator("img").evaluate((image: HTMLImageElement) => {
          if (image.alt) image.alt = "changed accessible label";
          image.style.content = "none";
        });
        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 140, height: 100 });
        const walk = (nodes: CapturedElement[]): CapturedElement[] => nodes.flatMap((n) => [n, ...walk(n.children)]);
        const image = walk(capture.tree).find((n) => n.tag === "img")!;
        expect(capture.warnings.filter((w) => w.feature === "broken-image-fallback")).toEqual([]);
        expect(image.brokenImageFallback).toMatchObject({
          disposition: "primary",
          loadState: "loaded",
          captureStatus: "exact",
          paintOwnership: "none",
          source: { complete: true, naturalWidth: 1, naturalHeight: 1 },
        });
        expect(image.brokenImageFallback?.container).toBeUndefined();
        expect(image.brokenImageFallback?.text).toBeUndefined();
        expect(image.brokenImageFallback?.accessibility).toMatchObject(
          alt ? { ignored: false, role: "image", name: "changed accessible label" } : { ignored: true, name: null },
        );
        await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(capture.tree, 140, 100)}`);
        const center = async (bytes: Buffer) => [
          ...(await sharp(bytes).removeAlpha().extract({ left: 30, top: 18, width: 4, height: 4 }).raw().toBuffer()),
        ];
        const native = await center(await page.screenshot());
        expect(native.every((channel) => channel === 0)).toBe(true);
        expect(await center(await generated.screenshot())).toEqual(native);

        await page.locator("img").evaluate((image: HTMLImageElement, src) => {
          image.src = src;
        }, BROKEN);
        await page.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth === 0);
        const relapse = await captureLiveImages(page, "__stq", { x: 0, y: 0, width: 140, height: 100 });
        expect(relapse.warnings).toEqual([]);
        expect(relapse.captured[0].brokenImageFallback).toMatchObject({
          disposition: alt ? "non-replaced-fallback" : "replaced-flow-root-fallback",
          loadState: "failed",
          icon: { visible: true },
        });
      }
    } finally {
      await generated.close();
      await page.close();
    }
  }, 60_000);

  it("paints the img's own generated content image in place of src or a retained UA shadow (DM-G47E97)", async () => {
    // HTMLImageElement::CreateLayoutObject (html_image_element.cc:509-532,
    // Chromium 6b5a1b80): an unerrored first content image owns the box; an
    // errored one hands layout back to the src disposition; an image followed
    // by a non-alt item leaves an empty ordinary box (content_data.h:433-445).
    const svg = (fill: string) =>
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="${fill}"/></svg>`,
      );
    const magenta = svg("magenta");
    const cases = [
      { content: `url("${magenta}")`, expected: [255, 0, 255] },
      { content: `url("${magenta}") / "label"`, expected: [255, 0, 255] },
      { content: `url("${BROKEN}")`, expected: [0, 0, 0] },
      // An ordinary box: empty when fresh, the retained UA shadow when recovered.
      { content: `url("${magenta}") "text"`, expected: null },
    ];
    const page = await env!.browser.newPage({ viewport: { width: 140, height: 100 } });
    const generated = await env!.browser.newPage({ viewport: { width: 140, height: 100 } });
    const pixel = async (bytes: Buffer) => [
      ...(await sharp(bytes).removeAlpha().extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer()),
    ];
    try {
      for (const recovered of [false, true]) {
        for (const { content, expected } of cases) {
          await page.setContent(
            `<!doctype html><style>body{margin:0;background:white}</style><img alt="" src="${recovered ? BROKEN : svg("black")}">`,
          );
          await page.waitForFunction(() => document.images[0].complete);
          if (recovered) {
            // A failed image keeps its UA shadow after recovering (DM-STQYYJ).
            await page.locator("img").evaluate(async (image: HTMLImageElement, src) => {
              image.style.width = "40px";
              image.style.height = "30px";
              image.src = src;
              await image.decode();
            }, svg("black"));
          }
          await page.locator("img").evaluate((image: HTMLImageElement, value) => {
            image.style.content = value;
          }, content);
          await page.waitForTimeout(100);
          const native = await pixel(await page.screenshot());
          if (expected != null) expect(native, `${content} recovered=${recovered}`).toEqual(expected);
          else if (!recovered) expect(native).toEqual([255, 255, 255]);
          else expect(native).not.toEqual([255, 255, 255]);
          const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 140, height: 100 });
          expect(capture.warnings.filter((w) => w.feature === "broken-image-fallback")).toEqual([]);
          if (expected == null && recovered) {
            // Classified as the retained shadow; painting it under a 0x0
            // inline host is tracked separately (DM-GXK8X1).
            const walk = (nodes: CapturedElement[]): CapturedElement[] =>
              nodes.flatMap((n) => [n, ...walk(n.children)]);
            expect(walk(capture.tree).find((n) => n.tag === "img")?.brokenImageFallback).toMatchObject({
              disposition: "non-replaced-fallback",
              icon: { visible: true },
            });
            continue;
          }
          await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(capture.tree, 140, 100)}`);
          await generated.waitForTimeout(100);
          expect(await pixel(await generated.screenshot()), `${content} recovered=${recovered}`).toEqual(native);
        }
      }
    } finally {
      await generated.close();
      await page.close();
    }
  }, 60_000);

  for (const dpr of [1, 2]) {
    it(`captures source-owned layout/text/font/AX facts at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({
        viewport: { width: 760, height: 500 },
        deviceScaleFactor: dpr,
      });
      const page = await context.newPage();
      const registry = `__dm2463_${dpr}`;
      try {
        await page.setContent(
          `<!doctype html><style>
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
        <img id="nosrc" alt="no source">`,
          { waitUntil: "load" },
        );
        const { byId, warnings } = await captureLiveImages(page, registry, { x: 0, y: 0, width: 760, height: 500 });

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
          container: {
            display: "flow-root",
            overflowX: "hidden",
            border: { top: dpr > 0 ? 1 : 1 },
            padding: { top: 1 },
          },
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
        await page
          .evaluate((key) => {
            delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
          }, registry)
          .catch(() => {});
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
      await page.setContent(
        `<!doctype html><style>
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
      <img id="long" src="${BROKEN}" alt="a very long alternative label that must retain physical range geometry">`,
        { waitUntil: "load" },
      );
      const standards = await captureLiveImages(page, standardsKey, { x: 0, y: 0, width: 900, height: 560 });
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
      await page.setContent(
        `<style>html,body{margin:0}img{display:block;margin:8px;font:16px/20px sans-serif}#quirks-both{white-space:nowrap}</style>
        <img id="quirks-one" src="${BROKEN}" width="70" alt="one dimension becomes replaced in quirks">
        <img id="quirks-both" src="${BROKEN}" width="100" height="28" alt="long clipped alternative text">
        <img id="quirks-ratio" src="${BROKEN}" style="width:90px;aspect-ratio:3/1" alt="ratio text">`,
        { waitUntil: "load" },
      );
      expect(await page.evaluate(() => document.compatMode)).toBe("BackCompat");
      const quirks = await captureLiveImages(page, quirksKey, { x: 0, y: 0, width: 900, height: 560 });
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
      await page.route("https://slow.example.test/slow.png", (route) => {
        loadingRoute = route;
      });
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
      const loading = await captureLiveImages(page, loadingKey, { x: 0, y: 0, width: 900, height: 560 });
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
      await page.setContent(
        `<!doctype html><img id="collapsed" src="https://blocked.example.test/image.png" alt="blocked">`,
        { waitUntil: "load" },
      );
      const collapsed = await captureLiveImages(page, collapsedKey, { x: 0, y: 0, width: 900, height: 560 });
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
        await page
          .evaluate((value) => {
            delete (globalThis as typeof globalThis & Record<string, unknown>)[value];
          }, key)
          .catch(() => {});
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
      await page.setContent(
        `<!doctype html><style>
        html,body{margin:0}img{display:block;margin:8px;font:18px/24px sans-serif}
      </style>
      <img src="${BROKEN}" alt="pipeline text">
      <img src="${BROKEN}" alt="">
      <img src="${BROKEN}" width="18" height="18" alt="">
      <img src="${GOOD}" width="20" height="20" alt="successful">
      <img title="title without source">`,
        { waitUntil: "load" },
      );

      const result = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 420, height: 240 });
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
