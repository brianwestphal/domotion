import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try {
    return { browser: await launchChromium({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] }) };
  } catch {
    return null;
  }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

const CUSTOM_CSS = `
  .scrollbox{width:180px;height:120px;overflow:scroll;border:3px solid #111}
  .scrollbox::-webkit-scrollbar{width:16px;height:14px;background:#aaa}
  .scrollbox::-webkit-scrollbar-track{background:rgb(201,31,32)}
  .scrollbox::-webkit-scrollbar-thumb{background:rgb(33,61,203);border:2px solid rgb(201,31,32)}
  .scrollbox::-webkit-scrollbar-corner{background:rgb(25,155,71)}
  .scrollbox::-webkit-scrollbar-button{display:none}
`;

describeBrowser("DM-2481: authoritative Blink scrollbar capture", () => {
  it("embeds exact same-frame platform-native strip pixels without resampling", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 400, height: 260 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const scratch = await mkdtemp(join(tmpdir(), "domotion-native-scrollbar-"));
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;overflow:hidden}
        #native{margin:20.25px;width:200px;height:140px;overflow:scroll;resize:both;
          scrollbar-color:rgb(20,40,160) rgb(230,220,200);scrollbar-width:auto;
          background:rgb(255,238,221);border:3px solid rgb(17,34,51)}
        #native>div{width:600px;height:500px;background:linear-gradient(#efe,#fee)}
        #sentinel{position:absolute;left:300px;top:30px;width:22px;height:19px;background:rgb(7,201,91)}
        #none{overflow:scroll;scrollbar-width:none;width:30px;height:30px}
        #visible{overflow:visible;width:30px;height:30px}
        #auto-empty{overflow:auto;width:30px;height:30px}
      </style>
      <div id="native" data-domotion-anim="native"><div></div></div>
      <div id="sentinel"></div>
      <div id="none" data-domotion-anim="none"><div style="width:90px;height:90px"></div></div>
      <div id="visible" data-domotion-anim="visible"><div style="width:90px;height:90px"></div></div>
      <div id="auto-empty" data-domotion-anim="auto-empty"></div>`);
      const nativeBox = (await page.locator("#native").boundingBox())!;
      await page.locator("#native").evaluate((element) => {
        element.scrollTop = 100;
        element.scrollLeft = 70;
      });
      // Keep the platform overlay animator in its hovered state while the
      // capture prepasses run; programmatic offsets avoid inertial-scroll drift.
      await page.mouse.move(nativeBox.x + nativeBox.width - 2, nativeBox.y + 50);
      await page.waitForTimeout(250);
      const sourcePath = join(scratch, "source.png");
      await writeFile(sourcePath, await page.screenshot({ type: "png" }));

      const capture = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 400, height: 260 },
        { rasterizeFromImagePath: sourcePath },
      );
      const target = byAnimId(capture.tree, "native")!;
      const set = target.scrollbars!;
      expect(set).toMatchObject({
        status: "captured", overlay: true, paintPhase: "overlay-overflow-controls",
        captureDpr: 2,
        outputTransform: { space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] },
        missingFacts: [],
      });
      expect(byAnimId(capture.tree, "none")?.scrollbars?.status).toBe("absent");
      expect(byAnimId(capture.tree, "visible")?.scrollbars).toBeUndefined();
      expect(byAnimId(capture.tree, "auto-empty")?.scrollbars?.status).toBe("absent");
      expect(capture.warnings.filter(({ feature }) => feature === "scrollbar-capture")).toEqual([]);

      const source = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const bar of [set.horizontal, set.vertical]) {
        const raster = bar?.nativeRaster;
        expect(raster).toMatchObject({
          captureDpr: 2, precomposited: true,
          opacitySource: "precomposited-source-frame",
          interaction: { hostHovered: true, hostPressed: false },
          platformFingerprint: { hideScrollbarsDefaultRemoved: true },
        });
        expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
        expect(raster?.pixelWidth).toBe(Math.round((raster?.width ?? 0) * 2));
        expect(raster?.pixelHeight).toBe(Math.round((raster?.height ?? 0) * 2));
        const encoded = Buffer.from(raster!.dataUri!.split(",")[1]!, "base64");
        const crop = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const left = Math.round(raster!.x * 2);
        const top = Math.round(raster!.y * 2);
        const expected = Buffer.alloc(crop.info.width * crop.info.height * 4);
        for (let y = 0; y < crop.info.height; y++) {
          const start = ((top + y) * source.info.width + left) * 4;
          expected.set(source.data.subarray(start, start + crop.info.width * 4), y * crop.info.width * 4);
        }
        expect(Buffer.compare(crop.data, expected)).toBe(0);
      }

      const svg = elementTreeToSvg(capture.tree, 400, 260);
      expect(svg.indexOf("native-horizontal")).toBeLessThan(svg.indexOf("native-vertical"));
      expect(svg).toContain('data-domotion-scrollbar-route="native-raster"');
      expect(svg).toContain("rgb(7,201,91)");
      expect(svg).not.toContain('fill="rgba(0,0,0,0.40)"');

      const outputPage = await context.newPage();
      try {
        await outputPage.setContent(`<style>html,body{margin:0}</style>${svg}`);
        const output = await sharp(await outputPage.screenshot({ type: "png" }))
          .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (const bar of [set.horizontal, set.vertical]) {
          const raster = bar!.nativeRaster!;
          const left = Math.round(raster.x * 2);
          const top = Math.round(raster.y * 2);
          for (let y = 0; y < raster.pixelHeight; y++) {
            const sourceStart = ((top + y) * source.info.width + left) * 4;
            const outputStart = ((top + y) * output.info.width + left) * 4;
            expect(Buffer.compare(
              source.data.subarray(sourceStart, sourceStart + raster.pixelWidth * 4),
              output.data.subarray(outputStart, outputStart + raster.pixelWidth * 4),
            )).toBe(0);
          }
        }
      } finally {
        await outputPage.close();
      }
    } finally {
      await context.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("selects the author route when customization exists only on a part pseudo", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #part-only{margin:20px;width:180px;height:120px;overflow:scroll}
        #part-only::-webkit-scrollbar-thumb{background:rgb(33,61,203)}
        #part-only>div{width:500px;height:500px}
      </style><div id="part-only" data-domotion-anim="part-only"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const set = byAnimId(capture.tree, "part-only")!.scrollbars!;
      expect([set.horizontal?.route, set.vertical?.route]).toContain("author-custom");
      const thumb = set.vertical?.parts.find(({ kind }) => kind === "thumb");
      expect(thumb?.finalPseudoStyle?.backgroundColor).toBe("rgb(33, 61, 203)");
    } finally {
      await page.close();
    }
  });

  it("keeps anonymous state-dependent paint as an owner-only part crop", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #dynamic{margin:20px;width:180px;height:120px;overflow:scroll}
        #dynamic::-webkit-scrollbar{width:16px;height:14px;background:rgb(201,31,32)}
        #dynamic::-webkit-scrollbar-track{background:rgb(201,31,32)}
        #dynamic::-webkit-scrollbar-thumb{background:rgb(33,61,203)!important}
        #dynamic::-webkit-scrollbar-thumb:vertical{background:rgb(171,42,199)!important}
        #dynamic::-webkit-scrollbar-button{display:none}
        #dynamic>div{width:500px;height:500px}
      </style><div id="dynamic" data-domotion-anim="dynamic"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const target = byAnimId(capture.tree, "dynamic")!;
      const verticalThumb = target.scrollbars?.vertical?.parts.find(({ kind }) => kind === "thumb");
      const horizontalThumb = target.scrollbars?.horizontal?.parts.find(({ kind }) => kind === "thumb");
      expect(verticalThumb?.raster).toMatchObject({
        provenance: "dynamic-author-part",
        captureDpr: 1,
      });
      expect(verticalThumb?.raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      // Detection is deliberately conservative at pseudo-kind granularity:
      // stable CDP cannot prove which anonymous orientation instance won, so
      // both thumb owners stay source pixels instead of replaying selectors.
      expect(horizontalThumb?.raster?.provenance).toBe("dynamic-author-part");
      const svg = elementTreeToSvg(capture.tree, 360, 240);
      expect(svg).toContain('data-domotion-scrollbar-part="track"');
      expect(svg).toContain('data-domotion-scrollbar-part="thumb"');
      expect(svg).toContain("data:image/png;base64,");
      expect(svg).not.toContain("dynamic-scrollbar-pseudo-cascade");
    } finally {
      await page.close();
    }
  });

  it("rasterizes an unsupported effect only inside the author part owner", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #filtered{margin:20px;width:180px;height:120px;overflow:scroll}
        #filtered::-webkit-scrollbar{width:16px;height:14px;background:rgb(201,31,32)}
        #filtered::-webkit-scrollbar-track{background:rgb(201,31,32)}
        #filtered::-webkit-scrollbar-thumb{background:rgb(33,61,203);filter:blur(1px)}
        #filtered::-webkit-scrollbar-button{display:none}
        #filtered>div{width:500px;height:500px}
      </style><div id="filtered" data-domotion-anim="filtered"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const target = byAnimId(capture.tree, "filtered")!;
      const thumb = target.scrollbars?.vertical?.parts.find(({ kind }) => kind === "thumb");
      const track = target.scrollbars?.vertical?.parts.find(({ kind }) => kind === "track");
      expect(thumb?.raster).toMatchObject({ provenance: "unsupported-author-part" });
      expect(thumb?.raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(track?.raster).toBeUndefined();
      const svg = elementTreeToSvg(capture.tree, 360, 240);
      const thumbGroup = svg.slice(svg.indexOf('data-domotion-scrollbar-part="thumb"'));
      expect(thumbGroup).toContain("<image");
      expect(svg).toContain('data-domotion-scrollbar-part="track"');
    } finally {
      await page.close();
    }
  });

  it("captures custom frame/part geometry, ranges, corner, logical side, and final unqualified winners", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 700, height: 330 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}${CUSTOM_CSS}
        .scrollbox{position:absolute;top:20px}
        #ltr{left:20px}
        #rtl{left:250px;direction:rtl}
        #none{left:480px;scrollbar-width:none}
      </style>
      <div id="ltr" class="scrollbox" data-domotion-anim="ltr"><div style="width:500px;height:500px"></div></div>
      <div id="rtl" class="scrollbox" data-domotion-anim="rtl"><div style="width:500px;height:500px"></div></div>
      <div id="none" class="scrollbox" data-domotion-anim="none"><div style="width:500px;height:500px"></div></div>`);
      await page.locator("#ltr").evaluate((element) => {
        element.scrollTop = 120;
        element.scrollLeft = 80;
      });
      await page.locator("#rtl").evaluate((element) => {
        element.scrollTop = 90;
        element.scrollLeft = -70;
      });
      await page.locator("#none").evaluate((element) => {
        element.scrollTop = 60;
        element.scrollLeft = 50;
      });

      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 700, height: 330 });
      const ltr = byAnimId(capture.tree, "ltr")!;
      const rtl = byAnimId(capture.tree, "rtl")!;
      const none = byAnimId(capture.tree, "none")!;

      expect(ltr.scrollbars).toMatchObject({
        status: "captured",
        source: "blink-live-marker-probe-v1",
        overlay: false,
        paintPhase: "background",
        captureDpr: 1,
        effectiveZoom: 1,
        horizontal: {
          route: "author-custom",
          logicalSide: "bottom",
          currentPosition: 80,
          frameRect: { height: 14 },
        },
        vertical: {
          route: "author-custom",
          logicalSide: "right",
          currentPosition: 120,
          frameRect: { width: 16 },
        },
        corner: { kind: "corner", rect: { width: 16, height: 14 } },
      });
      expect(ltr.scrollbars?.vertical?.parts.find(({ kind }) => kind === "thumb")?.finalPseudoStyle)
        .toMatchObject({ backgroundColor: "rgb(33, 61, 203)", border: "2px solid rgb(201, 31, 32)" });
      expect(ltr.scrollbars?.horizontal?.parts.map(({ kind }) => kind)).toEqual([
        "background", "track", "back-track", "forward-track", "thumb",
      ]);
      expect(rtl.scrollbars?.vertical?.logicalSide).toBe("left");
      expect(rtl.scrollbars?.horizontal?.currentPosition).toBe(-70);
      expect(none.scrollbars).toMatchObject({ status: "absent", horizontal: undefined, vertical: undefined });

      const scrollbarWarnings = capture.warnings.filter(({ feature }) => feature === "scrollbar-capture");
      expect(scrollbarWarnings).toEqual([]);

      const svg = elementTreeToSvg(capture.tree, 700, 330);
      expect(svg).not.toContain('fill="rgba(0,0,0,0.40)"');
      expect(svg).toContain('data-domotion-scrollbar-route="author-custom"');
      expect(svg).toContain('data-domotion-scrollbar-part="thumb"');
    } finally {
      await page.close();
    }
  });

  it("normalizes device pixels once while retaining CSS zoom and capture DPR", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 420, height: 280 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}${CUSTOM_CSS}
        #zoomed{margin:20px;zoom:1.25}
      </style><div id="zoomed" class="scrollbox" data-domotion-anim="zoomed"><div style="width:500px;height:500px"></div></div>`);
      await page.locator("#zoomed").evaluate((element) => { element.scrollTop = 100; });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 420, height: 280 });
      const set = byAnimId(capture.tree, "zoomed")!.scrollbars!;
      expect(set.captureDpr).toBe(2);
      expect(set.effectiveZoom).toBeCloseTo(1.25, 5);
      expect(set.vertical?.frameRect.width).toBeCloseTo(20, 1);
      expect(Math.abs((set.horizontal?.frameRect.height ?? 0) - 17.5)).toBeLessThanOrEqual(0.5);
      expect(set.outputTransform).toEqual({ space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] });
    } finally {
      await context.close();
    }
  });

  it("fails closed when a non-axis-aligned transform prevents source-axis correlation", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 520, height: 360 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}${CUSTOM_CSS}
        #rotated{margin:70px;transform:rotate(8deg);transform-origin:top left}
      </style><div id="rotated" class="scrollbox" data-domotion-anim="rotated"><div style="width:500px;height:500px"></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 520, height: 360 });
      const set = byAnimId(capture.tree, "rotated")!.scrollbars!;
      expect(set).toMatchObject({ status: "unavailable", horizontal: undefined, vertical: undefined });
      expect(set.missingFacts).toContain("scrollbar-axis-under-non-axis-aligned-transform");
      expect(capture.warnings).toContainEqual(expect.objectContaining({
        selector: "div#rotated",
        feature: "scrollbar-capture",
      }));
    } finally {
      await page.close();
    }
  });

  it("retains forced-colors and dark-scheme context when theme paint hides marker colors", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 280 } });
    try {
      await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
      await page.setContent(`<!doctype html><style>
        html,body{margin:0;background:Canvas;color-scheme:light dark}
        #forced{margin:20px;width:180px;height:120px;overflow:scroll}
        #forced>div{width:500px;height:500px}
      </style><div id="forced" data-domotion-anim="forced"><div></div></div>`);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 420, height: 280 });
      const set = byAnimId(capture.tree, "forced")!.scrollbars!;
      expect(set.forcedColors).toBe(true);
      if (set.status === "absent") {
        // A fully faded platform overlay has no source-frame ink. This is a
        // proven negative, not the old marker-paint failure.
        expect(set.noInkReason).toBe("overlay-source-frame-empty");
      } else {
        expect(["captured", "partial"]).toContain(set.status);
        for (const bar of [set.horizontal, set.vertical]) {
          if (bar != null) expect(bar.usedColorScheme).toBe("dark");
        }
      }
    } finally {
      await page.close();
    }
  });

  it("retains viewport scrollbar ownership when the selected body root omits html", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        html::-webkit-scrollbar{width:16px;height:14px;background:#aaa}
        html::-webkit-scrollbar-track{background:rgb(201,31,32)}
        html::-webkit-scrollbar-thumb{background:rgb(33,61,203)}
        html::-webkit-scrollbar-corner{background:rgb(25,155,71)}
        html::-webkit-scrollbar-button{display:none}
        main{width:700px;height:650px;background:#eee}
      </style><main></main>`);
      await page.evaluate(() => { window.scrollTo(80, 110); });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      expect(capture.tree[0]?.rootScrollbars).toMatchObject({
        rootScroller: true,
        overlay: false,
        horizontal: { route: "author-custom", currentPosition: 80 },
        vertical: { route: "author-custom", currentPosition: 110 },
      });
      expect(await page.evaluate(() => ({
        computed: [getComputedStyle(document.documentElement).overflowX, getComputedStyle(document.documentElement).overflowY],
        inline: [document.documentElement.style.overflowX, document.documentElement.style.overflowY],
      }))).toEqual({ computed: ["visible", "visible"], inline: ["", ""] });
    } finally {
      await page.close();
    }
  });

  it("records Playwright's hidden-scrollbar launch as an explicit unavailable negative", async () => {
    const hiddenBrowser = await launchChromium({ headless: true });
    const page = await hiddenBrowser.newPage({ viewport: { width: 360, height: 240 } });
    try {
      await page.setContent(`<!doctype html><style>html,body{margin:0}${CUSTOM_CSS}</style>
        <div id="hidden" class="scrollbox" data-domotion-anim="hidden"><div style="width:500px;height:500px"></div></div>`);
      await page.locator("#hidden").evaluate((element) => { element.scrollTop = 80; });
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const set = byAnimId(capture.tree, "hidden")!.scrollbars!;
      expect(set.status).toBe("unavailable");
      expect(set.missingFacts).toEqual(expect.arrayContaining(["scrollbar-object-existence", "marker-paint"]));
      expect(capture.warnings).toContainEqual(expect.objectContaining({
        selector: "div#hidden",
        feature: "scrollbar-capture",
      }));
    } finally {
      await page.close();
      await closeBrowserSafely(hiddenBrowser);
    }
  });
});
