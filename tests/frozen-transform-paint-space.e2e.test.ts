import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Browser } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Static translate/scale transforms are captured untransformed and re-applied
// by the renderer's <g transform>, because Blink snaps box paint in local space
// before applying the transform (ToPixelSnappedRect, Chromium 7d859f27
// core/paint/box_painter_base.cc:1058). Chromium raster surfaces painted by the
// live page must land in the same place. Each case renders native Chromium and
// the SVG at the same viewport and counts pixels that differ by more than 40.

const WIDTH = 220;
const HEIGHT = 140;
let browser: Browser;

beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

// `strict` counts every pixel whose RGBA differs at all.
async function differingPixels(
  html: string,
  mutate?: (tree: CapturedElement[]) => void,
  strict = false,
): Promise<{ count: number; svg: string; tree: CapturedElement[] }> {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const out = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  try {
    await page.setContent(`<style>body{margin:0;background:white;font:14px sans-serif}</style>${html}`);
    const native = await sharp(await page.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    mutate?.(tree);
    const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
    await out.setContent(`<style>body{margin:0;background:white}</style>${svg}`);
    const actual = await sharp(await out.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer();
    let count = 0;
    for (let offset = 0; offset < native.length; offset += 4) {
      const delta = Math.max(
        Math.abs(native[offset] - actual[offset]),
        Math.abs(native[offset + 1] - actual[offset + 1]),
        Math.abs(native[offset + 2] - actual[offset + 2]),
        Math.abs(native[offset + 3] - actual[offset + 3]),
      );
      if (delta > (strict ? 0 : 40)) count++;
    }
    return { count, svg, tree };
  } finally {
    await page.close();
    await out.close();
  }
}

const transformedOwner = (nodes: CapturedElement[]): CapturedElement | undefined => {
  for (const node of nodes) {
    if (node.styles.transform != null && node.styles.transform !== "none") return node;
    const found = transformedOwner(node.children);
    if (found) return found;
  }
  return undefined;
};

const container = (transform: string, content: string): string =>
  `<div style="margin:20px;transform:${transform};transform-origin:0 0;width:150px">${content}</div>`;

describe("frozen-transform paint space", () => {
  it.each([
    [
      "fractional translate outline",
      `<div style="width:20px;height:20px;margin:20.5px;transform:translate(-.5px,-.5px);outline:2px solid red"></div>`,
    ],
    [
      "scaled border",
      `<div style="width:20px;height:20px;margin:30px;transform:scale(1.5);border:2px solid blue"></div>`,
    ],
  ])("paints the %s in the box's local space", async (_name, html) => {
    expect((await differingPixels(html)).count).toBe(0);
  });

  it.each([["translate(10.5px,10px)"], ["scale(1.2)"], ["rotate(5deg)"]])(
    "places native control, decoration and replaced rasters inside %s",
    async (transform) => {
      for (const content of [
        `<button>Press</button>`,
        `<input type=checkbox checked>`,
        `<input type=range>`,
        `<input value="hi" style="width:80px">`,
        `<canvas width=40 height=30 id=c></canvas><script>const x=document.getElementById('c').getContext('2d');x.fillStyle='purple';x.fillRect(5,5,30,20)</script>`,
      ]) {
        const { count } = await differingPixels(container(transform, content));
        expect(count, `${content} under ${transform}`).toBeLessThanOrEqual(5);
      }
    },
  );

  it("leaves no style attribute on a frozen owner that had none", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    try {
      await page.setContent(
        `<style>#owner{transform:translate(10.5px,10px) scale(1.2);transform-origin:0 0}</style><div id="owner"><input value="hi"><canvas width="20" height="10"></canvas></div>`,
      );
      await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      expect(await page.locator("#owner").evaluate((owner) => owner.getAttribute("style"))).toBeNull();
    } finally {
      await page.close();
    }
  });

  // The margin keeps the box origin on whole pixels at each zoom, so the
  // only fractional geometry is the transform's own.
  // Computed transform/translate/transform-origin serialize in unzoomed CSS px
  // (ComputedStyleUtils::ValueForTransform zooms the matrix by 1/zoom), while
  // captured geometry is zoomed layout px.
  const unzoomFrozen = (zoom: number) => (tree: CapturedElement[]) => {
    const visit = (node: CapturedElement) => {
      const m = /^matrix\(([^)]+)\)$/.exec(node.styles.transform ?? "");
      if (m != null) {
        const v = m[1].split(",").map(Number);
        node.styles.transform = `matrix(${v[0]}, ${v[1]}, ${v[2]}, ${v[3]}, ${v[4] / zoom}, ${v[5] / zoom})`;
        node.styles.transformOrigin = (node.styles.transformOrigin ?? "")
          .split(" ")
          .map((part) => `${parseFloat(part) / zoom}px`)
          .join(" ");
      }
      node.children.forEach(visit);
    };
    tree.forEach(visit);
  };
  it.each([
    ["translate under zoom 0.8", 0.8, 10, "transform:translate(17px,9px)"],
    ["translate under zoom 1.25", 1.25, 8, "transform:translate(17px,9px)"],
    ["scale about a fractional origin under zoom 1.25", 1.25, 8, "transform:scale(1.5);transform-origin:7.5px 3.25px"],
  ])("applies the effective zoom to a frozen %s", async (_name, zoom, margin, css) => {
    const html = `<div style="zoom:${zoom}"><div style="margin:${margin}px;width:40px;height:24px;background:#1d4ed8;outline:2px solid #dc2626;${css}"></div></div>`;
    expect((await differingPixels(html)).count).toBe(0);
    // Negative control: the unzoomed computed matrix and origin misplace it.
    expect((await differingPixels(html, unzoomFrozen(zoom))).count).toBeGreaterThan(20);
  });

  // A running animation outranks an inline write in the cascade, and a running
  // transition outranks even `!important` (CascadeOrigin, Chromium 7d859f27
  // core/css/resolver/cascade_origin.h:15-35). The freeze must still read the
  // untransformed box, or the renderer applies the rotation twice.
  const rotatedBox = `position:absolute;left:60px;top:40px;width:80px;height:44px;background:#1d4ed8;transform-origin:50% 50%`;
  it.each([
    [
      "a paused rotate animation at its midpoint",
      `<style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(20deg)}}#t{${rotatedBox};animation:spin 2s linear infinite paused;animation-delay:-1s}</style><div id="t"></div>`,
    ],
    [
      "a rotation with a declared transition",
      `<style>#t{${rotatedBox};transform:rotate(10deg);transition:transform 1s}</style><div id="t"></div>`,
    ],
    ["a skew owned by a script animation", `<div id="t" style="${rotatedBox}"></div>`],
    [
      "an author !important rotation",
      `<style>#t{${rotatedBox};transform:rotate(10deg) !important}</style><div id="t"></div>`,
    ],
  ])("freezes %s without applying it twice", async (name, html) => {
    const script = name.includes("script animation")
      ? `<script>document.getElementById("t").animate([{transform:"skewX(12deg)"},{transform:"skewX(12deg)"}],{duration:1e6}).pause()</script>`
      : "";
    const { count, tree } = await differingPixels(html + script, undefined, true);
    expect(count).toBe(0);
    // Activation control: the owner is recorded at its untransformed box. A
    // freeze the cascade ignores records the rotated bounding box instead.
    expect(transformedOwner(tree)).toMatchObject({ x: 60, y: 40, width: 80, height: 44 });
  });

  // The override animation is not copied when the walk clones an inline SVG
  // root, so the clone must not carry the root's transform attribute too.
  it("does not let a frozen inline SVG root's clone apply its transform again", async () => {
    const html = `<svg style="position:absolute;left:60px;top:30px" width="80" height="60" viewBox="0 0 80 60" transform="rotate(20)"><rect width="80" height="24" fill="#ea580c"/><rect y="36" width="30" height="24" fill="#2563eb"/></svg>`;
    const { count, tree } = await differingPixels(html);
    // Counted at the default threshold: a strict comparison also counts the
    // rotated content's edge coverage.
    expect(count).toBe(0);
    expect(transformedOwner(tree)?.svgContent).toMatch(/style="[^"]*transform: none/);
    // Negative control: without the pinned identity the clone's attribute
    // rotates the content a second time.
    const unpinned = await differingPixels(html, (nodes) => {
      const owner = transformedOwner(nodes);
      if (owner?.svgContent != null) owner.svgContent = owner.svgContent.replace(/\btransform: none;?/, "");
    });
    expect(unpinned.count).toBeGreaterThan(100);
  });

  it("overrides a running transition without firing transition events or disturbing it", async () => {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    try {
      await page.setContent(
        `<style>#t{${rotatedBox};transform:rotate(5deg);transition:transform 100s linear}</style><div id="t"></div>`,
      );
      const before = await page.evaluate(async () => {
        const target = document.getElementById("t")!;
        const events: string[] = [];
        (window as unknown as { events: string[] }).events = events;
        for (const type of ["transitionrun", "transitionstart", "transitionend", "transitioncancel"])
          target.addEventListener(type, () => events.push(type));
        target.style.transform = "rotate(25deg)";
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const transition = target.getAnimations()[0];
        // Hold it so its time and value can be compared exactly. A held
        // transition still sits in the transition origin above the override.
        transition.pause();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        events.length = 0;
        return {
          time: Number(transition.currentTime),
          transform: getComputedStyle(target).transform,
          state: transition.playState,
        };
      });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      const frozen = transformedOwner(tree);
      expect(frozen).toMatchObject({ x: 60, y: 40, width: 80, height: 44 });
      expect(before.state).toBe("paused");
      expect(frozen?.styles.transform).toBe(before.transform);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await page.evaluate(() => {
        const target = document.getElementById("t")!;
        const animations = target.getAnimations();
        return {
          events: (window as unknown as { events: string[] }).events,
          count: animations.length,
          time: Number(animations[0]?.currentTime),
          transform: getComputedStyle(target).transform,
          style: target.getAttribute("style"),
        };
      });
      expect(after).toEqual({
        events: [],
        count: 1,
        time: before.time,
        transform: before.transform,
        style: "transform: rotate(25deg);",
      });
    } finally {
      await page.close();
    }
  });

  it("resolves a percentage translate longhand against the border box", async () => {
    const { count } = await differingPixels(
      `<div style="position:relative;height:100px"><div style="position:absolute;left:110px;top:50px;width:80px;height:20px;translate:-50% 8px;background:#166534"></div></div>`,
    );
    expect(count).toBe(0);
  });
});
