import { chromium, type Browser } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

/**
 * DM-1446 — a recursed same-origin `<iframe>` whose inner content references a
 * same-document `mask-image: url(#id)` / `clip-path: url(#id)` / `filter:
 * url(#id)` fragment must resolve that fragment against the INNER document
 * (`el.ownerDocument`), not the outer one, so the `<mask>`/`<clipPath>`/
 * `<filter>` def is hoisted into the output SVG. Regression guard for the
 * `el.ownerDocument` fix in `masks-clips.ts`.
 */

const INNER = `<!doctype html><html><head><style>
  body{margin:0;background:#fff}
  .clip{width:120px;height:120px;background:#e11;clip-path:url(#innerClip)}
  .mask{width:120px;height:120px;background:#1a1;-webkit-mask-image:url(#innerMask);mask-image:url(#innerMask)}
  .filt{width:120px;height:60px;background:#14e;filter:url(#innerBlur)}
</style></head><body>
  <svg width="0" height="0"><defs>
    <clipPath id="innerClip"><circle cx="60" cy="60" r="50"/></clipPath>
    <mask id="innerMask"><rect width="120" height="120" fill="white"/><circle cx="60" cy="60" r="40" fill="black"/></mask>
    <filter id="innerBlur"><feGaussianBlur stdDeviation="3"/></filter>
  </defs></svg>
  <div class="clip"></div>
  <div class="mask"></div>
  <div class="filt"></div>
</body></html>`;

const env = await (async () => {
  try {
    return { browser: await chromium.launch() };
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeBrowserSafely(env?.browser as Browser | null | undefined);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

async function luminanceAtCss(png: Buffer, x: number, y: number, dpr: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Math.max(0, Math.min(info.width - 1, Math.floor(x * dpr)));
  const py = Math.max(0, Math.min(info.height - 1, Math.floor(y * dpr)));
  const offset = (py * info.width + px) * info.channels;
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

function escapedSrcdoc(source: string): string {
  return source.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const EXACT_WIDTH = 470;
const EXACT_HEIGHT = 380;
const EXACT_INNER = `<!doctype html><style>
  html,body{margin:0;width:300px;height:330px;background:white}
  svg{position:absolute;width:0;height:0;overflow:hidden}
  .case{position:absolute;width:80px;height:60px;background:#111}
  #obb{left:10px;top:10px;clip-path:url(#sharedClip)}
  #user{left:110px;top:10px;box-sizing:border-box;border:6px solid #111;padding:9px;clip-path:url(#innerUserClip)}
  #lum{left:10px;top:90px;mask-image:url(#sharedMask)}
  #alpha{left:110px;top:90px;box-sizing:border-box;border:8px solid #111;padding:7px;mask-image:url(#alphaMask);mask-origin:content-box;mask-clip:content-box;mask-size:9px 7px;mask-position:100% 100%;mask-repeat:repeat}
  #objmask{left:10px;top:170px;mask-image:url(#objectContentMask)}
  #usermask{left:110px;top:170px;mask-image:url(#userRegionMask)}
  .zoomhost{position:absolute;top:250px}.zoomcase{width:40px;height:30px;background:#111;zoom:2}
  #zclipwrap{left:10px}#zmaskwrap{left:110px}
  #zoomclip{clip-path:url(#innerUserClip)}
  #zoommask{mask-image:url(#zoomUserMask);mask-mode:alpha}
  #sharedMask{mask-type:luminance}
  #alphaMask{mask-type:alpha}
</style><svg><defs>
  <clipPath id="sharedClip" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath>
  <clipPath id="innerUserClip" clipPathUnits="userSpaceOnUse"><rect x="10" y="5" width="30" height="40"/></clipPath>
  <linearGradient id="tone"><stop offset="0" stop-color="white"/><stop offset=".5" stop-color="white"/><stop offset=".5" stop-color="black"/><stop offset="1" stop-color="black"/></linearGradient>
  <mask id="sharedMask"><rect width="80" height="60" fill="url(#tone)"/></mask>
  <mask id="alphaMask"><rect width="40" height="60" fill="black"/><rect x="40" width="40" height="60" fill="transparent"/></mask>
  <mask id="objectContentMask" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox"><rect width=".5" height="1" fill="white"/></mask>
  <mask id="userRegionMask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="32" height="60"><rect width="80" height="60" fill="white"/></mask>
  <mask id="zoomUserMask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="10" y="0" width="20" height="30"><rect width="40" height="30" fill="black"/></mask>
</defs></svg><div id="obb" class="case"></div><div id="user" class="case"></div>
<div id="lum" class="case"></div><div id="alpha" class="case"></div>
<div id="objmask" class="case"></div><div id="usermask" class="case"></div>
<div id="zclipwrap" class="zoomhost"><div id="zoomclip" class="zoomcase"></div></div>
<div id="zmaskwrap" class="zoomhost"><div id="zoommask" class="zoomcase"></div></div>`;

function exactOuter(): string {
  return `<!doctype html><style>
    html,body{margin:0;width:${EXACT_WIDTH}px;height:${EXACT_HEIGHT}px;background:white}
    svg{position:absolute;width:0;height:0;overflow:hidden}
    .outer{position:absolute;left:370px;width:80px;height:60px;background:#111}
    #outerClip{top:20px;clip-path:url(#sharedClip)}
    #outerMask{top:100px;mask-image:url(#sharedMask)}
    iframe{position:absolute;left:42px;top:28px;width:300px;height:330px;border:6px solid #777}
  </style><svg><defs>
    <clipPath id="sharedClip" clipPathUnits="objectBoundingBox"><rect x=".5" width=".5" height="1"/></clipPath>
    <mask id="sharedMask"><linearGradient id="tone"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient><rect width="40" height="60" fill="black"/><rect x="40" width="40" height="60" fill="white"/></mask>
  </defs></svg><div id="outerClip" class="outer"></div><div id="outerMask" class="outer"></div>
  <iframe srcdoc="${escapedSrcdoc(EXACT_INNER)}"></iframe>`;
}

describeBrowser("recursed iframe inner mask/clip/filter defs (DM-1446)", () => {
  it("hoists same-document mask / clip-path / filter defs defined inside the iframe", async () => {
    const ctx = await env!.browser.newContext({ viewport: { width: 400, height: 400 } });
    const page = await ctx.newPage();
    try {
      await page.setContent(
        `<div style="padding:10px;"><iframe srcdoc="${INNER.replace(/"/g, "&quot;")}" width="360" height="340" style="border:0;display:block;"></iframe></div>`,
      );
      await page.waitForLoadState("networkidle");
      const { tree, warnings } = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 400, height: 400 });
      const root = tree[0] as CapturedElement & {
        maskDefs?: { id: string }[];
        clipPathDefs?: { id: string }[];
        filterDefs?: { id: string }[];
      };

      expect((root.maskDefs ?? []).map((d) => d.id)).toContain("innerMask");
      expect((root.clipPathDefs ?? []).map((d) => d.id)).toContain("innerClip");
      expect((root.filterDefs ?? []).map((d) => d.id)).toContain("innerBlur");

      // No "did not resolve to an inline <…>" warnings for the inner defs.
      const unresolved = warnings.filter((w) =>
        /did not resolve to an inline/.test(JSON.stringify(w)),
      );
      expect(unresolved).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it.each([1, 2])("keeps iframe fragment identity, coordinate systems, and mask semantics exact at DPR %i", async (dpr) => {
    const context = await env!.browser.newContext({
      viewport: { width: EXACT_WIDTH, height: EXACT_HEIGHT },
      deviceScaleFactor: dpr,
    });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent(exactOuter(), { waitUntil: "load" });
      await source.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelectorAll(".case,.zoomcase").length === 8);
      const sourcePng = await source.screenshot();
      const { tree, warnings } = await captureElementTreeWithWarnings(source, "body", {
        x: 0, y: 0, width: EXACT_WIDTH, height: EXACT_HEIGHT,
      });
      expect(warnings.filter((warning) => /did not resolve to an inline/.test(warning.detail))).toEqual([]);

      const root = tree[0];
      const sharedMasks = (root.maskDefs ?? []).filter((def) => def.id === "sharedMask");
      const sharedClips = (root.clipPathDefs ?? []).filter((def) => def.id === "sharedClip");
      expect(sharedMasks).toHaveLength(2);
      expect(sharedClips).toHaveLength(2);
      expect(new Set(sharedMasks.map((def) => def.scope)).size).toBe(2);
      expect(new Set(sharedClips.map((def) => def.scope)).size).toBe(2);
      expect((root.maskDefs ?? []).find((def) => def.id === "alphaMask")?.maskType).toBe("alpha");
      expect((root.maskDefs ?? []).find((def) => def.id === "objectContentMask")?.maskContentUnits).toBe("objectBoundingBox");
      expect((root.maskDefs ?? []).find((def) => def.id === "userRegionMask")?.userSpaceRegion)
        .toEqual({ x: 0, y: 0, width: 32, height: 60 });
      expect((root.maskDefs ?? []).find((def) => def.id === "zoomUserMask")?.maskType).toBe("luminance");
      const innerSharedMask = sharedMasks.find((def) => def.dependencyGraph?.nodes.some((node) => node.id === "tone"));
      expect(innerSharedMask?.dependencyGraph?.nodes.map((node) => node.id)).toEqual(["sharedMask", "tone"]);
      expect(innerSharedMask?.dependencyGraph?.edges).toHaveLength(2);
      expect(innerSharedMask?.dependencyGraph?.edges.every((edge) =>
        edge.from === 0 && edge.to === 1 && edge.target === "tone" && edge.status === "resolved",
      )).toBe(true);

      const scopedConsumers = flatten(tree).filter((node) => /^url\(/.test(node.styles.clipPath)
        || /^url\(/.test(node.styles.maskImage));
      expect(scopedConsumers).toHaveLength(10);
      expect(scopedConsumers.every((node) => node.fragmentReferenceScope != null)).toBe(true);
      expect(scopedConsumers.filter((node) => node.fragmentReferenceZoom === 2)).toHaveLength(2);

      const svg = elementTreeToSvgInner(tree, EXACT_WIDTH, EXACT_HEIGHT);
      const nestedToneIds = [...svg.matchAll(/id="([^"]*fragid-tone)"/g)].map((match) => match[1]);
      expect(nestedToneIds).toHaveLength(2);
      expect(new Set(nestedToneIds).size).toBe(2);
      expect(svg).toContain('transform="translate(58, 204) scale(80, 60)"');
      expect(svg).toMatch(/style="[^"]*mask-type:alpha"/);

      await rendered.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${EXACT_WIDTH}" height="${EXACT_HEIGHT}" viewBox="0 0 ${EXACT_WIDTH} ${EXACT_HEIGHT}"><rect width="100%" height="100%" fill="white"/>${svg}</svg></body>`, { waitUntil: "load" });
      const renderedPng = await rendered.screenshot();
      const probes = [
        [380, 50, false, "outer objectBoundingBox left is clipped"],
        [430, 50, true, "outer objectBoundingBox right survives"],
        [380, 130, false, "outer luminance black is hidden"],
        [430, 130, true, "outer luminance white survives"],
        [68, 74, true, "inner objectBoundingBox left survives at iframe content offset"],
        [118, 74, false, "inner objectBoundingBox right is clipped"],
        [162, 74, false, "inner userSpace pre-origin stays clipped"],
        [175, 74, true, "inner userSpace origin includes iframe viewport offset"],
        [68, 154, true, "inner luminance white survives"],
        [118, 154, false, "inner luminance black is hidden"],
        [160, 154, true, "SVG mask source ignores hostile mask-clip content-box"],
        [168, 154, true, "stylesheet-owned alpha keeps opaque black visible"],
        [208, 154, false, "stylesheet-owned alpha hides transparent content"],
        [68, 234, true, "objectBoundingBox mask content scales to left half"],
        [118, 234, false, "objectBoundingBox mask content clips right half"],
        [168, 234, true, "userSpace mask region starts at consumer origin"],
        [208, 234, false, "userSpace mask region owns the right boundary"],
        [65, 314, false, "zoomed userSpace clip preserves the pre-origin gap"],
        [90, 314, true, "zoomed userSpace clip scales source coordinates once"],
        [165, 314, false, "zoomed userSpace mask region preserves the pre-origin gap"],
        [190, 314, true, "explicit alpha mode keeps zoomed opaque black visible"],
        [225, 314, false, "zoomed userSpace mask region scales its width once"],
      ] as const;
      for (const [x, y, dark, label] of probes) {
        const sourceLuma = await luminanceAtCss(sourcePng, x, y, dpr);
        const renderedLuma = await luminanceAtCss(renderedPng, x, y, dpr);
        expect(sourceLuma, `Chromium: ${label}`).toSatisfy((value: number) => dark ? value < 40 : value > 215);
        expect(renderedLuma, `Domotion: ${label}`).toSatisfy((value: number) => dark ? value < 40 : value > 215);
      }
    } finally {
      await context.close();
    }
  }, 60_000);
});
