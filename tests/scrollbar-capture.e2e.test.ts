import { afterAll, describe, expect, it } from "vitest";

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
        status: "partial",
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
        "back-track", "thumb", "forward-track",
      ]);
      expect(rtl.scrollbars?.vertical?.logicalSide).toBe("left");
      expect(rtl.scrollbars?.horizontal?.currentPosition).toBe(-70);
      expect(none.scrollbars).toMatchObject({ status: "absent", horizontal: undefined, vertical: undefined });

      const scrollbarWarnings = capture.warnings.filter(({ feature }) => feature === "scrollbar-capture");
      expect(scrollbarWarnings.map(({ selector }) => selector).sort()).toEqual(["div#ltr", "div#rtl"]);
      expect(scrollbarWarnings.every(({ detail }) => detail.includes("dynamic-scrollbar-pseudo-cascade"))).toBe(true);

      const svg = elementTreeToSvg(capture.tree, 700, 330);
      expect(svg).not.toContain('fill="rgba(0,0,0,0.40)"');
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
      expect(["partial", "unavailable"]).toContain(set.status);
      for (const bar of [set.horizontal, set.vertical]) {
        if (bar != null) expect(bar.usedColorScheme).toBe("dark");
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
