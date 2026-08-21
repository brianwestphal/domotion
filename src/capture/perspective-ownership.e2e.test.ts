import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../index.js";
import type { CapturedElement } from "./types.js";
import { elementTreeToSvgInner } from "../render/element-tree-to-svg.js";
import { establishesStackingContext, isFixedContainingBlock } from "../render/stacking.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

const WIDTH = 760;
const HEIGHT = 430;
const HTML = `<!doctype html><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; }
  .owner { position: absolute; width: 200px; height: 120px; border: 3px solid #111; overflow: hidden; }
  .pin { position: fixed; left: 7px; top: 9px; width: 18px; height: 18px; }
</style>
<div class="owner" id="active" style="left:50px;top:40px;perspective:420px;perspective-origin:15% 70%">
  <i class="pin" style="background:rgb(201, 31, 31)"></i>
</div>
<div class="owner" id="inactive" style="left:300px;top:40px;perspective:none;perspective-origin:15% 70%">
  <i class="pin" style="background:rgb(31, 201, 31)"></i>
</div>
<div class="owner" id="preserve" style="left:50px;top:220px;transform-style:preserve-3d">
  <i class="pin" style="background:rgb(31, 31, 201)"></i>
</div>
<div class="owner" id="hinted" style="left:300px;top:220px;will-change:perspective">
  <i class="pin" style="background:rgb(201, 121, 31)"></i>
</div>
<div class="owner" id="origin-only" style="left:550px;top:40px;width:160px;perspective-origin:20% 80%">
  <i class="pin" style="background:rgb(151, 31, 201)"></i>
</div>
<div style="position:absolute;left:550px;top:220px;width:160px;height:100px;border:3px solid #555;overflow:hidden">
  <span id="inline-owner" style="perspective:420px">inline perspective<i class="pin" style="background:rgb(31, 151, 201)"></i></span>
</div>
<div id="inline-stack-root" style="position:absolute;left:550px;top:350px;width:160px;height:60px">
  <span id="inline-stack-owner" style="position:relative;perspective:420px">x<i id="inline-deep" style="position:absolute;left:0;top:0;width:30px;height:30px;background:rgb(231, 41, 41);z-index:999"></i></span>
  <span id="inline-filtered" style="perspective:420px;filter:blur(0px)">filtered</span>
  <b id="inline-cover" style="position:absolute;left:0;top:0;width:30px;height:30px;background:rgb(41, 41, 231);z-index:1"></b>
</div>`;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function clipState(svg: string, fill: string): "escaped" | "trapped" | "missing" {
  const wanted = fill.replace(/\s+/g, "");
  let fillIndex = -1;
  for (const match of svg.matchAll(/\bfill="([^"]+)"/g)) {
    if (match[1].replace(/\s+/g, "") === wanted) {
      fillIndex = match.index;
      break;
    }
  }
  if (fillIndex < 0) return "missing";
  const stack: string[] = [];
  for (const token of svg.slice(0, fillIndex).matchAll(/<g\b[^>]*>|<\/g>/g)) {
    if (token[0] === "</g>") stack.pop();
    else stack.push(token[0]);
  }
  return stack.some((tag) => tag.includes('clip-path="url(#ov')) ? "trapped" : "escaped";
}

describeBrowser("DM-2385 perspective capture and fixed containing-block ownership", () => {
  it("matches Blink's live fixed-position containing-block decisions", async () => {
    const page = await env!.browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const facts = await page.evaluate(() => {
        const fact = (id: string) => {
          const owner = document.getElementById(id)!;
          const pin = owner.querySelector(".pin")!;
          const ownerRect = owner.getBoundingClientRect();
          const pinRect = pin.getBoundingClientRect();
          const style = getComputedStyle(owner);
          return {
            owner: [ownerRect.left, ownerRect.top],
            pin: [pinRect.left, pinRect.top],
            perspective: style.perspective,
            perspectiveOrigin: style.perspectiveOrigin,
            transformStyle: style.transformStyle,
            willChange: style.willChange,
          };
        };
        return {
          active: fact("active"),
          inactive: fact("inactive"),
          preserve: fact("preserve"),
          hinted: fact("hinted"),
          originOnly: fact("origin-only"),
          inline: fact("inline-owner"),
          inlineStackTop: document.elementsFromPoint(560, 360)
            .map((node) => node.id)
            .find((id) => id === "inline-deep" || id === "inline-cover"),
        };
      });

      expect(facts.active).toMatchObject({
        owner: [50, 40],
        pin: [60, 52],
        perspective: "420px",
        perspectiveOrigin: "30px 84px",
      });
      expect(facts.inactive).toMatchObject({ pin: [7, 9], perspective: "none" });
      expect(facts.preserve).toMatchObject({
        pin: [60, 232],
        transformStyle: "preserve-3d",
      });
      expect(facts.hinted).toMatchObject({ pin: [310, 232], willChange: "perspective" });
      expect(facts.originOnly).toMatchObject({
        pin: [7, 9],
        perspective: "none",
        perspectiveOrigin: "32px 96px",
      });
      expect(facts.inline).toMatchObject({ pin: [7, 9], perspective: "420px" });
      // LayoutInline::LayerTypeRequired gives a positioned inline a paint
      // layer. ComputedStyle's active perspective then traps z-index even
      // though the same non-box inline cannot own the fixed child above.
      expect(facts.inlineStackTop).toBe("inline-cover");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("threads computed perspective/origin into capture and keeps paint under the owning clip", async () => {
    const page = await env!.browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", {
        x: 0,
        y: 0,
        width: WIDTH,
        height: HEIGHT,
      });
      const nodes = walk(tree);
      const active = nodes.find((node) => node.styles.perspective === "420px");
      const inactive = nodes.find((node) =>
        node.x === 300 && node.y === 40 && node.styles.perspective === "none");
      const preserve = nodes.find((node) => node.styles.transformStyle === "preserve-3d");
      const hinted = nodes.find((node) => node.styles.willChange === "perspective");
      const inline = nodes.find((node) =>
        node.styles.display === "inline" && node.styles.perspective === "420px");
      const inlineStack = nodes.find((node) =>
        node.styles.display === "inline"
        && node.styles.position === "relative"
        && node.styles.perspective === "420px");
      const inlineFiltered = nodes.find((node) =>
        node.styles.display === "inline"
        && node.styles.filter === "blur(0px)"
        && node.styles.perspective === "420px");

      expect(active?.styles.perspectiveOrigin).toBe("30px 84px");
      expect(active?.transformSubtreeRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(inactive?.styles.perspectiveOrigin).toBe("30px 84px");
      expect(inactive?.transformSubtreeRaster).toBeUndefined();
      expect(preserve?.styles.transformStyle).toBe("preserve-3d");
      expect(hinted?.styles.perspective).toBe("none");
      expect(inline?.styles.transformRelatedBox).toBe(false);
      expect(inline?.transformSubtreeRaster).toBeUndefined();
      expect(establishesStackingContext(inline!)).toBe(false);
      expect(inlineStack?.styles.transformRelatedBox).toBe(false);
      expect(inlineStack?.transformSubtreeRaster).toBeUndefined();
      expect(establishesStackingContext(inlineStack!)).toBe(true);
      expect(isFixedContainingBlock(inlineStack!)).toBe(false);
      // The capture probe masks independent fixed-CB reasons while asking the
      // transform question: filter still owns fixed paint through its own
      // route, but must not make ignored inline perspective activate raster.
      expect(inlineFiltered?.styles.transformRelatedBox).toBe(false);
      expect(inlineFiltered?.transformSubtreeRaster).toBeUndefined();
      expect(isFixedContainingBlock(inlineFiltered!)).toBe(true);
      expect(nodes.map((node) => node.styles.backgroundColor)).toEqual(
        expect.arrayContaining(["rgb(231, 41, 41)", "rgb(41, 41, 231)"]),
      );

      const svg = elementTreeToSvgInner(tree, WIDTH, HEIGHT);
      const pinFills = nodes
        .filter((node) => node.styles.position === "fixed")
        .map((node) => node.styles.backgroundColor);
      expect(pinFills).toEqual([
        "rgb(201, 31, 31)",
        "rgb(31, 201, 31)",
        "rgb(31, 31, 201)",
        "rgb(201, 121, 31)",
        "rgb(151, 31, 201)",
        "rgb(31, 151, 201)",
      ]);
      // Active perspective owns a Chromium-composited subtree image. Its red
      // fixed child must not be hoisted and painted a second time as a vector.
      expect(svg).toContain("<image");
      expect(clipState(svg, "rgb(201, 31, 31)")).toBe("missing");
      // perspective:none and origin-only controls stay viewport-fixed and
      // escape the same overflow clip; preserve-3d and will-change:perspective
      // remain fixed to their owning boxes and therefore under that clip.
      expect(clipState(svg, "rgb(31, 201, 31)")).toBe("escaped");
      expect(clipState(svg, "rgb(31, 31, 201)")).toBe("trapped");
      expect(clipState(svg, "rgb(201, 121, 31)")).toBe("trapped");
      expect(clipState(svg, "rgb(151, 31, 201)")).toBe("escaped");
      expect(clipState(svg, "rgb(31, 151, 201)")).toBe("escaped");
      expect(svg.indexOf('fill="rgb(231,41,41)"')).toBeLessThan(
        svg.indexOf('fill="rgb(41,41,231)"'),
      );
    } finally {
      await page.close();
    }
  }, 60_000);
});
