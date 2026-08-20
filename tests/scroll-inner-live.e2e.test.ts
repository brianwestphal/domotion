import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { executeScrollPattern } from "../src/scroll/executor.js";
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
});
