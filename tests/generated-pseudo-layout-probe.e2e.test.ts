import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const HTML = `<!doctype html><style>
  body { margin: 0; }
  #host { --pseudo-inline: 31px; position: relative; width: 240px; height: 150px; font: 16px Arial; }
  #host::before, #reference {
    box-sizing: content-box;
    content: "縦 AB";
    position: absolute;
    left: 12px;
    top: 9px;
    width: calc(var(--pseudo-inline) + 10%);
    padding: 3px 5px 7px 11px;
    border: 2px solid transparent;
    writing-mode: vertical-rl;
    font: italic 700 19px/23px Arial;
    letter-spacing: 1px;
    background: rgb(1, 2, 3);
  }
  #reference { content: normal; visibility: hidden; }
</style><div id="host">host<span id="reference">縦 AB</span></div>`;

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function pseudoBox(tree: CapturedElement[]) {
  let box: { width: number; height: number } | undefined;
  const visit = (nodes: CapturedElement[]): void => {
    for (const node of nodes) {
      const record = node.pseudoFragments?.find((entry) => entry.pseudo === "::before"
        && entry.fragments.some((fragment) => fragment.kind === "text" && fragment.text.includes("縦 AB")));
      if (record != null) box = record.boxFragments[0]?.physicalRect;
      if (node.children) visit(node.children as CapturedElement[]);
    }
  };
  visit(tree);
  return box;
}

describeBrowser("DM-2191: generated pseudo layout probe", () => {
  it("matches an equivalent real box with vars, calc, vertical writing, and pseudo typography", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 220 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const expected = await page.locator("#reference").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 220 });
      const actual = pseudoBox(tree);
      expect(actual, "captured generated-content paint box").toBeDefined();
      expect(actual!.width).toBeCloseTo(expected.width, 4);
      expect(actual!.height).toBeCloseTo(expected.height, 4);
    } finally {
      await page.close();
    }
  }, 60_000);
});
