import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { executeScrollPattern } from "../src/scroll/executor.js";
import { composeScrollSvg } from "../src/scroll/composer.js";
import { parseScrollPattern } from "../src/scroll/pattern.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function allText(nodes: CapturedElement[]): string {
  return nodes.map((node) => `${node.text ?? ""} ${allText(node.children)}`).join(" ");
}

describeBrowser("inner live-scroll capture", () => {
  it("captures only the clipped scroller and re-captures recycled virtual rows", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 320, height: 220 } });
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0}.header{height:60px;background:red}#list{margin-left:30px;width:200px;height:100px;overflow:auto}
        #spacer{height:1000px;position:relative}.row{position:absolute;left:0;width:180px;height:20px}
      </style><div class="header">HEADER MUST NOT REPEAT</div><div id="list"><div id="spacer"></div></div>
      <script>
        const list=document.querySelector('#list'), spacer=document.querySelector('#spacer');
        function paint(){const first=Math.floor(list.scrollTop/20);spacer.replaceChildren(...Array.from({length:6},(_,i)=>{const d=document.createElement('div');d.className='row';d.style.top=((first+i)*20)+'px';d.textContent='ROW '+(first+i);return d}))}
        list.addEventListener('scroll',paint);paint();
      </script>`);
      const segments = await executeScrollPattern(page, parseScrollPattern("down:80px until 2 times"), {
        selector: "#list",
        captureSelector: "#list",
        captureViewport: { x: 30, y: 60, width: 200, height: 100 },
        viewportW: 200,
        viewportH: 100,
        prescroll: false,
      });

      expect(segments).toHaveLength(3);
      expect(segments.map((segment) => segment.scrollY)).toEqual([0, 80, 160]);
      const texts = segments.map((segment) => allText(segment.tree));
      expect(texts.every((text) => !text.includes("HEADER MUST NOT REPEAT"))).toBe(true);
      expect(texts[0]).toContain("ROW 0");
      expect(texts[1]).toContain("ROW 4");
      expect(texts[2]).toContain("ROW 8");
      expect(await page.locator("#list .row").count()).toBe(6);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("keeps the surrounding page static when an element owns the scroll", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 260 } });
    const renderPage = await env!.browser.newPage({ viewport: { width: 360, height: 260 } });
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0;background:#eef2f8;font:16px sans-serif}.header{height:60px;background:#17324d;color:white}
        .shell{padding:20px}#list{width:260px;height:120px;overflow:auto;background:white;border:4px solid #e5484d}
        .row{height:40px;border-bottom:1px solid #ccd}
      </style><div class="header">STATIC HEADER</div><main class="shell"><div id="list">
        ${Array.from({ length: 12 }, (_, i) => `<div class="row">ROW ${i}</div>`).join("")}
      </div><p>STATIC FOOTER</p></main>`);

      // Pin the real ownership distinction which exposed DM-2703: this is a
      // fixed-position element viewport inside a larger captured body.
      expect(await page.locator("#list").evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          rect: [rect.x, rect.y, rect.width, rect.height],
          overflow: [style.overflowX, style.overflowY],
        };
      })).toEqual({ rect: [20, 80, 268, 128], overflow: ["auto", "auto"] });

      const segments = await executeScrollPattern(page, parseScrollPattern("down:80px/400ms"), {
        selector: "#list",
        captureSelector: "body",
        captureViewport: { x: 0, y: 0, width: 360, height: 260 },
        viewportW: 360,
        viewportH: 260,
        prescroll: false,
      });
      const svg = composeScrollSvg(segments, { viewportW: 360, viewportH: 260 });
      expect(svg).toContain('data-scroll-static-context="true"');
      expect(svg).toContain("STATIC HEADER");
      expect(svg).toContain("STATIC FOOTER");

      await renderPage.setContent(`<style>html,body{margin:0}</style>${svg.replace(/^<\?xml[^>]*>\s*/, "")}`);
      await renderPage.evaluate(async () => { await document.fonts.ready; });
      const at = async (time: number, clip?: { x: number; y: number; width: number; height: number }) => {
        await renderPage.evaluate((currentTime) => {
          for (const animation of document.getAnimations()) {
            animation.pause();
            animation.currentTime = currentTime;
          }
        }, time);
        return await renderPage.screenshot(clip == null ? {} : { clip });
      };
      const start = await at(0);
      const middle = await at(200);
      expect(start.equals(middle)).toBe(false);
      // Sample the header's solid plate away from glyph antialiasing; it must
      // remain byte-identical while the inner owner's contents animate.
      expect((await at(0, { x: 300, y: 10, width: 20, height: 20 })).equals(
        await at(200, { x: 300, y: 10, width: 20, height: 20 }),
      )).toBe(true);
    } finally {
      await renderPage.close();
      await page.close();
    }
  }, 60_000);

  it("records an unchanged leading pause as a same-offset timing anchor", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 320, height: 220 } });
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0}#list{width:200px;height:100px;overflow:auto}.row{height:40px}
      </style><div id="list">${Array.from({ length: 10 }, (_, i) => `<div class="row">ROW ${i}</div>`).join("")}</div>`);
      const segments = await executeScrollPattern(
        page,
        parseScrollPattern("pause:200ms,down:80px/400ms"),
        {
          selector: "#list",
          captureSelector: "#list",
          captureViewport: { x: 0, y: 0, width: 200, height: 100 },
          viewportW: 200,
          viewportH: 100,
          prescroll: false,
        },
      );

      expect(segments.map((segment) => ({
        scrollY: segment.scrollY,
        start: segment.segmentStartMs,
        end: segment.segmentEndMs,
        timelineOnly: segment.timelineOnly === true,
      }))).toEqual([
        { scrollY: 0, start: 0, end: 0, timelineOnly: false },
        { scrollY: 0, start: 0, end: 200, timelineOnly: true },
        { scrollY: 80, start: 200, end: 600, timelineOnly: false },
      ]);
      const svg = composeScrollSvg(segments, { viewportW: 200, viewportH: 100 });
      expect(svg).toMatch(/33\.333% \{ transform: translate3d\(0, -0\.000px, 0\)/);
      expect(svg).toMatch(/100\.000% \{ transform: translate3d\(0, -80\.000px, 0\)/);
    } finally {
      await page.close();
    }
  }, 60_000);
});
