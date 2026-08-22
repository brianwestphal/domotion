import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  captureElementTreeWithWarnings,
  launchChromium,
} from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}

function svgMarkup(nodes: CapturedElement[]): string[] {
  return walk(nodes).flatMap((node) => node.svgContent == null ? [] : [node.svgContent]);
}

function maxMatrixDelta(left: Matrix, right: Matrix): number {
  return Math.max(...(["a", "b", "c", "d", "e", "f"] as const).map((key) => Math.abs(left[key] - right[key])));
}

const MATRIX_HTML = `<!doctype html><style>
  body { margin: 0; }
  #css-override { transform: perspective(240px) rotateY(39deg) translateZ(17px); transform-box: fill-box; transform-origin: 23% 71% 29px; }
  #fill { transform: rotateY(47deg) translateZ(13px); transform-box: fill-box; transform-origin: 17% 83% 31px; }
  #stroke { transform: rotateY(47deg) translateZ(13px); transform-box: stroke-box; transform-origin: 17% 83% 31px; }
  #view { transform: rotateY(47deg) translateZ(13px); transform-box: view-box; transform-origin: 17% 83% 31px; }
  #content-alias { transform: rotateY(33deg); transform-box: content-box; transform-origin: 70% 20% 9px; }
  #border-alias { transform: rotateY(33deg); transform-box: border-box; transform-origin: 70% 20% 9px; }
  #nss { transform: rotateY(47deg) translateZ(13px); transform-box: stroke-box; transform-origin: 17% 83% 31px; }
  #independent { translate: 7px 11px 5px; rotate: y 31deg; scale: 1.1 .85 1.2; transform-origin: 37% 61% 14px; transform-box: fill-box; }
  #motion { offset-path: path("M 0 0 C 15 30 35 -10 52 18"); offset-distance: 43%; offset-rotate: 27deg; transform: rotateY(22deg); transform-box: fill-box; transform-origin: 30% 70% 8px; }
  #nested-group { transform: perspective(300px) rotateY(28deg); transform-origin: 41% 62% 12px; transform-box: view-box; }
  #nested-svg { transform: rotate(20deg); transform-origin: 50% 50%; transform-box: view-box; }
  #use-row { transform: rotateY(36deg) translateZ(9px); transform-origin: 25% 75% 16px; transform-box: fill-box; }
  #animated { animation: svg-freeze-spin 100s linear paused; animation-delay: -25s; transform-origin: 35% 65% 19px; transform-box: fill-box; }
  @keyframes svg-freeze-spin { from { transform: rotateY(0deg); } to { transform: rotateY(80deg) translateZ(20px); } }
</style>
<div style="zoom:1.35">
<svg id="matrix-subject" width="520" height="340" viewBox="0 0 520 340">
  <defs><g id="use-target"><path d="M0 0 L22 0 L12 19 Z" fill="#ef4444"/></g></defs>
  <style>#internal-style{transform:rotateY(38deg) translateZ(15px);transform-box:fill-box;transform-origin:27% 73% 18px}.paint-only{fill:rgb(14,116,144)}</style>
  <rect id="static" data-freeze x="8" y="8" width="42" height="25" transform="matrix(.92 .18 -.11 1.08 9 -6)"/>
  <rect id="css-override" data-freeze x="70" y="8" width="48" height="27" transform="translate(999 999)"/>
  <path id="fill" data-freeze d="M140 10 L195 12 L188 46 L151 38 Z" stroke="#111" stroke-width="7" stroke-linejoin="miter"/>
  <path id="stroke" data-freeze d="M220 10 L275 12 L268 46 L231 38 Z" stroke="#111" stroke-width="7" stroke-linejoin="miter"/>
  <path id="view" data-freeze d="M300 10 L355 12 L348 46 L311 38 Z" stroke="#111" stroke-width="7"/>
  <path id="content-alias" data-freeze d="M385 10 h45 v32 h-45z" stroke="#111" stroke-width="9"/>
  <path id="border-alias" data-freeze d="M455 10 h45 v32 h-45z" stroke="#111" stroke-width="9"/>
  <path id="nss" data-freeze d="M18 82 L73 84 L66 118 L29 110 Z" stroke="#111" stroke-width="11" vector-effect="non-scaling-stroke"/>
  <rect id="planar" data-freeze x="98" y="78" width="47" height="35" style="transform:matrix3d(.91,.17,0,0,-.08,1.04,0,0,0,0,1,0,12,-7,0,1);transform-origin:0 0"/>
  <rect id="independent" data-freeze x="170" y="78" width="48" height="35"/>
  <rect id="motion" data-freeze x="252" y="78" width="42" height="31"/>
  <g id="nested-group" data-freeze><rect x="330" y="78" width="52" height="34"/></g>
  <svg id="nested-svg" data-freeze x="410" y="72" width="88" height="58" viewBox="0 0 22 12" preserveAspectRatio="none">
    <rect id="nested-child" x="2" y="2" width="16" height="7" style="transform:rotateY(29deg);transform-origin:65% 35% 7px;transform-box:fill-box"/>
  </svg>
  <use id="use-row" class="use-row" data-freeze href="#use-target" x="38" y="170"/>
  <rect id="animated" data-freeze x="105" y="160" width="58" height="38"/>
  <rect id="plain" x="205" y="160" width="40" height="30"/>
  <rect id="internal-style" class="paint-only" data-freeze x="390" y="160" width="52" height="34" transform="translate(999 999)"/>
  <g id="smil" data-freeze>
    <animateTransform attributeName="transform" type="rotate" values="0 315 245;80 315 245" dur="100s" fill="freeze"/>
    <rect x="285" y="225" width="60" height="35"/>
    <animate attributeName="opacity" values="1;.7" dur="100s" fill="freeze"/>
  </g>
</svg></div>`;

describeBrowser("Blink-used affine freeze for cloned inline SVG graphics (DM-2473)", () => {
  it("round-trips Blink local matrices across 2D/3D, reference boxes, zoom, motion, animation, and nested viewports", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 760, height: 520 } });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent(MATRIX_HTML);
      await source.locator("#matrix-subject").evaluate((svg) => {
        const root = svg as SVGSVGElement;
        root.pauseAnimations();
        root.setCurrentTime(25);
      });
      const ids = await source.locator("[data-freeze]").evaluateAll((nodes) => nodes.map((node) => node.id));
      const sourceMatrices = await source.locator("#matrix-subject").evaluate((_, targetIds) => {
        const matrix = (value: DOMMatrix | SVGMatrix) => ({ a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f });
        return Object.fromEntries(targetIds.map((id) => {
          const node = document.getElementById(id)! as SVGGraphicsElement;
          const parent = node.parentElement! as SVGGraphicsElement;
          return [id, matrix(parent.getCTM()!.inverse().multiply(node.getCTM()!))];
        }));
      }, ids) as Record<string, Matrix>;

      const before = await source.locator("#matrix-subject").evaluate((svg) => ({
        childCount: svg.querySelectorAll("*").length,
        transforms: Array.from(svg.querySelectorAll<SVGElement>("[data-freeze]")).map((node) => ({
          id: node.id,
          attr: node.getAttribute("transform"),
          style: ["transform", "transform-origin", "transform-box", "translate", "rotate", "scale", "offset-path"].map((property) => [
            property,
            node.style.getPropertyValue(property),
            node.style.getPropertyPriority(property),
          ]),
        })),
      }));
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 760, height: 520 });
      const markup = svgMarkup(tree).find((value) => value.includes('id="matrix-subject"'))!;
      expect(markup).toBeTruthy();
      expect(markup).not.toContain("matrix3d(");
      expect(markup).not.toMatch(/(?:transform-origin|transform-box|offset-path|\btranslate|\brotate|\bscale)\s*:/i);
      expect(markup).not.toContain("<animateTransform");
      expect(markup).toContain('attributeName="opacity"');
      expect(markup).toContain(".paint-only");

      await rendered.setContent(markup);
      const frozenAttrs = await rendered.locator("#matrix-subject").evaluate((_, targetIds) => targetIds.map(
        (id) => document.getElementById(id)?.getAttribute("transform") ?? null,
      ), ids);
      for (let index = 0; index < ids.length; index++) {
        if (ids[index] === "use-row") continue; // replaced by the inlined .use-row wrapper
        expect(frozenAttrs[index], ids[index]).toMatch(/^matrix\(/);
      }
      expect(await rendered.locator("#plain").evaluate((node) => node.hasAttribute("transform"))).toBe(false);

      const renderedMatrices = await rendered.locator("#matrix-subject").evaluate((_, targetIds) => {
        const matrix = (value: DOMMatrix | SVGMatrix) => ({ a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f });
        return Object.fromEntries(targetIds.filter((id) => id !== "use-row").map((id) => {
          const node = document.getElementById(id)! as SVGGraphicsElement;
          const parent = node.parentElement! as SVGGraphicsElement;
          return [id, matrix(parent.getCTM()!.inverse().multiply(node.getCTM()!))];
        }));
      }, ids) as Record<string, Matrix>;
      for (const [id, matrix] of Object.entries(renderedMatrices)) {
        expect(maxMatrixDelta(matrix, sourceMatrices[id]), id).toBeLessThan(1 / 256);
      }

      const useSource = await source.locator("#use-row").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const root = node.ownerSVGElement!.getBoundingClientRect();
        const scale = root.width / 520;
        return { x: (rect.x - root.x) / scale, y: (rect.y - root.y) / scale, width: rect.width / scale, height: rect.height / scale };
      });
      const useRendered = await rendered.locator(".use-row").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const root = (node as SVGGraphicsElement).ownerSVGElement!.getBoundingClientRect();
        const scale = root.width / 520;
        return { x: (rect.x - root.x) / scale, y: (rect.y - root.y) / scale, width: rect.width / scale, height: rect.height / scale };
      });
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(useRendered[key] - useSource[key]), `use ${key}`).toBeLessThan(1 / 64);
      }

      // Every neutral sibling probe and isolated validation host was removed;
      // capture did not mutate authored source markup or child cardinality.
      expect(await source.locator("#matrix-subject").evaluate((svg) => ({
        childCount: svg.querySelectorAll("*").length,
        transforms: Array.from(svg.querySelectorAll<SVGElement>("[data-freeze]")).map((node) => ({
          id: node.id,
          attr: node.getAttribute("transform"),
          style: ["transform", "transform-origin", "transform-box", "translate", "rotate", "scale", "offset-path"].map((property) => [
            property,
            node.style.getPropertyValue(property),
            node.style.getPropertyPriority(property),
          ]),
        })),
      }))).toEqual(before);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("fails closed to one outer Chromium surface when CTM correlation is unavailable or singular", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 420, height: 220 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      await page.setContent(`<style>body{margin:0}</style>
        <svg id="unavailable" width="180" height="90"><rect id="probe" x="12" y="10" width="80" height="50" fill="red" style="transform:rotateY(37deg);transform-origin:30% 70% 13px"/></svg>
        <svg id="singular" width="180" height="90"><rect x="12" y="10" width="80" height="50" fill="blue" style="transform:scaleX(0)"/></svg>`);
      await page.locator("#probe").evaluate((node) => {
        (node as SVGGraphicsElement & { getCTM: () => null }).getCTM = () => null;
      });
      const before = await page.locator("body").evaluate(() => ({
        svgChildren: Array.from(document.querySelectorAll("svg")).map((svg) => svg.children.length),
        transforms: Array.from(document.querySelectorAll("svg rect")).map((rect) => ({
          attr: rect.getAttribute("transform"),
          computed: getComputedStyle(rect).transform,
          origin: getComputedStyle(rect).transformOrigin,
        })),
      }));
      const result = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 420, height: 220 });
      const owners = walk(result.tree).filter((node) => node.transformSubtreeRaster != null);
      expect(owners).toHaveLength(2);
      expect(owners.every((owner) => owner.svgContent != null)).toBe(true);
      expect(owners.every((owner) => owner.transformSubtreeRaster?.dataUri != null || owner.transformSubtreeRaster?.empty === true)).toBe(true);
      expect(result.warnings.filter((warning) => warning.feature === "inline-svg")).toHaveLength(2);
      expect(result.warnings.every((warning) => !/getBBox|stroke-width \/ 2/.test(warning.detail))).toBe(true);
      expect(await page.locator("body").evaluate(() => ({
        svgChildren: Array.from(document.querySelectorAll("svg")).map((svg) => svg.children.length),
        transforms: Array.from(document.querySelectorAll("svg rect")).map((rect) => ({
          attr: rect.getAttribute("transform"),
          computed: getComputedStyle(rect).transform,
          origin: getComputedStyle(rect).transformOrigin,
        })),
      }))).toEqual(before);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("proves literal matrix3d and apparent 2D-submatrix mutations cannot match Blink's flattened origin", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 280, height: 180 } });
    const page = await context.newPage();
    try {
      await page.setContent(`<svg width="240" height="140"><rect id="target" x="45" y="28" width="96" height="54" style="transform:perspective(230px) rotateY(43deg) translateZ(22px);transform-origin:17% 83% 31px;transform-box:fill-box"/></svg>`);
      const facts = await page.locator("#target").evaluate((node) => {
        const target = node as SVGGraphicsElement;
        const parent = target.parentElement as SVGGraphicsElement;
        const used = parent.getCTM()!.inverse().multiply(target.getCTM()!);
        const computed = getComputedStyle(target).transform;
        const matrix3d = new DOMMatrix(computed);
        return {
          used: { a: used.a, b: used.b, c: used.c, d: used.d, e: used.e, f: used.f },
          computed,
          submatrix: `matrix(${matrix3d.m11} ${matrix3d.m12} ${matrix3d.m21} ${matrix3d.m22} ${matrix3d.m41} ${matrix3d.m42})`,
        };
      });
      const mutationDelta = async (transform: string) => page.locator("#target").evaluate((node, value) => {
        const target = node as SVGGraphicsElement;
        target.removeAttribute("style");
        target.setAttribute("transform", value);
        const parent = target.parentElement as SVGGraphicsElement;
        const actual = parent.getCTM()!.inverse().multiply(target.getCTM()!);
        return { a: actual.a, b: actual.b, c: actual.c, d: actual.d, e: actual.e, f: actual.f };
      }, transform);
      expect(facts.computed).toMatch(/^matrix3d\(/);
      expect(maxMatrixDelta(await mutationDelta(facts.computed), facts.used)).toBeGreaterThan(1);
      await page.reload();
      await page.setContent(`<svg width="240" height="140"><rect id="target" x="45" y="28" width="96" height="54" style="transform:perspective(230px) rotateY(43deg) translateZ(22px);transform-origin:17% 83% 31px;transform-box:fill-box"/></svg>`);
      expect(maxMatrixDelta(await mutationDelta(facts.submatrix), facts.used)).toBeGreaterThan(1);
    } finally {
      await context.close();
    }
  }, 60_000);
});
