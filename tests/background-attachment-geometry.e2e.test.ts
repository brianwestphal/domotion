import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
} from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const TILE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">'
  + '<path fill="#e5212c" d="M0 0h4v4H0z"/><path fill="#12a66a" d="M4 0h4v4H4z"/>'
  + '<path fill="#1955d1" d="M0 4h4v4H0z"/><path fill="#f2bd1d" d="M4 4h4v4H4z"/></svg>',
).toString("base64")}`;

function flatten(elements: CapturedElement[]): CapturedElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

function withPosition(elements: CapturedElement[], position: string): CapturedElement {
  const found = flatten(elements).find((element) => element.styles.backgroundPosition === position);
  if (found == null) throw new Error(`missing captured background-position ${position}`);
  return found;
}

function withAnimId(elements: CapturedElement[], animId: string): CapturedElement {
  const found = flatten(elements).find((element) => element.animId === animId);
  if (found == null) throw new Error(`missing captured animation id ${animId}`);
  return found;
}

async function meanAbsoluteError(left: Buffer, right: Buffer): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(left).removeAlpha().raw().toBuffer(),
    sharp(right).removeAlpha().raw().toBuffer(),
  ]);
  expect(b.length).toBe(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("Blink URL background attachment geometry (DM-2479)", () => {
  for (const dpr of [1, 2]) {
    it(`matches independent Chromium pixels for scroll/fixed/local at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({ viewport: { width: 320, height: 220 }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const generated = await context.newPage();
      try {
        await source.setContent(`<style>
          html,body{margin:0;background:white;overflow:hidden}
          #stage{position:relative;width:320px;height:220px;background:white}
          .box{position:absolute;width:120px;height:70px;background-image:url("${TILE}");background-size:8px 8px;background-repeat:repeat}
          #fixed{left:15px;top:15px;background-position:3px 5px;background-attachment:fixed}
          #host{position:absolute;left:160px;top:15px;transform:translate(0)}
          #transformed{width:120px;height:70px;background-image:url("${TILE}");background-size:8px 8px;background-position:3px 5px;background-repeat:repeat;background-attachment:fixed}
          #local{left:15px;top:110px;box-sizing:border-box;border:5px solid #222;padding:7px;overflow:scroll;scrollbar-width:none;background-position:2px 3px;background-attachment:local}
          #local::-webkit-scrollbar{display:none}#local>i{display:block;width:260px;height:180px}
        </style><div id="stage"><div id="fixed" class="box"></div><div id="host"><div id="transformed"></div></div><div id="local" class="box"><i></i></div></div>`);
        await source.locator("#local").evaluate((element) => {
          element.scrollLeft = 37;
          element.scrollTop = 29;
        });
        await source.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const expected = await source.screenshot();
        const capture = await captureElementTreeWithWarnings(source, "#stage", { x: 0, y: 0, width: 320, height: 220 });
        const fixed = withPosition(capture.tree, "3px 5px");
        const local = withPosition(capture.tree, "2px 3px");
        const transformed = flatten(capture.tree).find((element) =>
          element !== fixed && element.styles.backgroundAttachment === "fixed");
        expect(fixed.styles.backgroundAttachmentGeometry?.fixedToViewport).toBe(true);
        expect(transformed?.styles.backgroundAttachmentGeometry?.fixedToViewport).toBe(false);
        expect(local.styles.backgroundAttachmentGeometry?.local).toMatchObject({
          active: true,
          scrollOffsetX: 37,
          scrollOffsetY: 29,
          borderPaintWidth: 284,
          borderPaintHeight: 204,
        });

        const svg = elementTreeToSvg(capture.tree, 320, 220);
        await generated.setContent(`<style>html,body{margin:0;background:white}</style>${svg}`);
        const actual = await generated.screenshot();
        expect(await meanAbsoluteError(expected, actual)).toBeLessThan(0.01);
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it("captures transform ownership, viewport/page scroll, zoomed local mutation, and root stitching", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 360, height: 240 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    try {
      await page.setContent(`<style>
        html{margin:0;background:transparent}body{margin:0;height:1100px;background-image:url("${TILE}");background-size:8px 8px;background-position:1px 1px}
        .bg{position:absolute;top:160px;width:70px;height:55px;background-image:url("${TILE}");background-size:8px 8px;background-repeat:repeat;background-attachment:fixed}
        #plain{left:10px;background-position:1px 2px}
        #translated{position:absolute;left:90px;top:160px;transform:translate(0)}#translated .bg{position:static;background-position:2px 3px}
        #will{position:absolute;left:170px;top:160px;will-change:transform}#will .bg{position:static;background-position:3px 4px}
        #perspective{position:absolute;left:250px;top:160px;perspective:500px}#perspective .bg{position:static;background-position:4px 5px}
        #inert{display:inline;transform:translate(2px)}#inert .bg{left:10px;top:230px;background-position:5px 6px}
        #local{left:100px;top:230px;width:120px;height:80px;box-sizing:border-box;border:6px solid;padding:8px;overflow:scroll;scrollbar-width:none;zoom:1.25;background-position:6px 7px;background-attachment:local}
        #local::-webkit-scrollbar{display:none}#local>i{display:block;width:260px;height:190px}
        #affine{position:absolute;left:250px;top:230px;transform:matrix(1.1,.22,-.18,.9,0,0);transform-origin:0 0}
        #affineLocal{position:static;width:90px;height:70px;overflow:scroll;scrollbar-width:none;background-image:url("${TILE}");background-size:8px 8px;background-repeat:repeat;background-position:7px 8px;background-attachment:local}
        #affineLocal::-webkit-scrollbar{display:none}#affineLocal>i{display:block;width:230px;height:170px}
      </style><div id="plain" class="bg"></div><div id="translated"><div class="bg"></div></div><div id="will"><div class="bg"></div></div><div id="perspective"><div class="bg"></div></div><span id="inert"><div class="bg"></div></span><div id="local" class="bg" data-domotion-anim="local"><i></i></div><div id="affine"><div id="affineLocal" data-domotion-anim="affine-local"><i></i></div></div>`);
      await page.locator("#local").evaluate((element) => { element.scrollLeft = 41; element.scrollTop = 23; });
      await page.locator("#affineLocal").evaluate((element) => { element.scrollLeft = 83; element.scrollTop = 47; });
      await page.evaluate(() => { scrollTo(0, 121); });
      const live = await page.evaluate(() => ({
        viewport: {
          width: Math.min(innerWidth, document.documentElement.clientWidth),
          height: Math.min(innerHeight, document.documentElement.clientHeight),
        },
        local: {
          x: (document.querySelector("#local") as HTMLElement).scrollLeft,
          y: (document.querySelector("#local") as HTMLElement).scrollTop,
        },
      }));
      const first = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      expect(withPosition(first.tree, "1px 2px").styles.backgroundAttachmentGeometry).toMatchObject({
        fixedToViewport: true,
        layoutViewport: { ...live.viewport },
      });
      expect(withPosition(first.tree, "2px 3px").styles.backgroundAttachmentGeometry?.fixedToViewport).toBe(false);
      expect(withPosition(first.tree, "3px 4px").styles.backgroundAttachmentGeometry?.fixedToViewport).toBe(false);
      // Perspective creates a containing block for fixed descendants, but the
      // pinned background rule checks PaintLayer::Transform (not perspective)
      // plus will-change transform, so the background itself remains fixed.
      expect(withPosition(first.tree, "4px 5px").styles.backgroundAttachmentGeometry?.fixedToViewport).toBe(true);
      expect(withPosition(first.tree, "5px 6px").styles.backgroundAttachmentGeometry?.fixedToViewport).toBe(true);
      const localFirst = withAnimId(first.tree, "local").styles.backgroundAttachmentGeometry?.local;
      expect(localFirst?.scrollOffsetX).toBe(Math.round(live.local.x * 1.25));
      expect(localFirst?.scrollOffsetY).toBe(Math.round(live.local.y * 1.25));
      // The affine ancestor is frozen and re-applied by the SVG wrapper. Its
      // matrix a/d terms therefore must not scale the snapped local offsets a
      // second time (83 would otherwise become 91 and 47 would become 42).
      expect(withAnimId(first.tree, "affine-local").styles.backgroundAttachmentGeometry?.local).toMatchObject({
        active: true,
        scrollOffsetX: 83,
        scrollOffsetY: 47,
      });
      expect(first.tree[0].styles.backgroundAttachmentGeometry?.canvas).toMatchObject({
        owner: "body-propagated",
        positioningRect: { y: -121 },
      });

      await page.locator("#local").evaluate((element) => { element.scrollLeft = 73; element.scrollTop = 59; });
      const second = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const localSecond = withAnimId(second.tree, "local").styles.backgroundAttachmentGeometry?.local;
      expect(localSecond?.scrollOffsetX).not.toBe(localFirst?.scrollOffsetX);
      expect(localSecond?.scrollOffsetY).not.toBe(localFirst?.scrollOffsetY);
      expect(localSecond?.borderPaintWidth).toBe(localFirst?.borderPaintWidth);
      expect(localSecond?.borderPaintHeight).toBe(localFirst?.borderPaintHeight);
    } finally {
      await context.close();
    }
  }, 60_000);
});
