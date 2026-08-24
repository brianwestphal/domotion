import { afterAll, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";

import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type {
  CapturedElement,
  CapturedTextPaintAffine,
  CapturedTextPaintQuad,
} from "../src/capture/types.js";
import { mapTextPaintPoint } from "../src/capture/text-fragment-geometry.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const VIEWPORT = { width: 1080, height: 900 };
const COS_37 = Math.cos(37 * Math.PI / 180);

const env = await (async () => {
  try { return { browser: await launchChromium({ headless: true }) }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: readonly CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function ownerFor(tree: readonly CapturedElement[], label: string): CapturedElement {
  const owner = walk(tree).find((node) =>
    node.textSegments?.some((segment) => segment.text.includes(label)) === true);
  if (owner == null) throw new Error(`captured owner for ${label} was not found`);
  return owner;
}

function matrixFor(tree: readonly CapturedElement[], label: string): CapturedTextPaintAffine {
  const fragments = ownerFor(tree, label).textPaintGeometry?.fragments;
  if (fragments == null || fragments.length === 0) throw new Error(`text geometry for ${label} was not captured`);
  return fragments[0].paintMatrix;
}

function determinant(matrix: CapturedTextPaintAffine): number {
  return matrix[0] * matrix[3] - matrix[1] * matrix[2];
}

function maxMappedResidual(
  matrix: CapturedTextPaintAffine,
  neutral: CapturedTextPaintQuad,
  paint: CapturedTextPaintQuad,
): number {
  let result = 0;
  for (let corner = 0; corner < 4; corner++) {
    const mapped = mapTextPaintPoint(matrix, {
      x: neutral[corner * 2],
      y: neutral[corner * 2 + 1],
    });
    result = Math.max(
      result,
      Math.abs(mapped.x - paint[corner * 2]),
      Math.abs(mapped.y - paint[corner * 2 + 1]),
    );
  }
  return result;
}

async function directTextQuads(page: Page, selector: string): Promise<CapturedTextPaintQuad[]> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { node } = await session.send("DOM.describeNode", { nodeId, depth: 1, pierce: true });
    const text = node.children?.find((child) => child.nodeType === 3);
    if (text?.backendNodeId == null) throw new Error(`${selector} direct text node is unavailable`);
    const result = await session.send("DOM.getContentQuads", { backendNodeId: text.backendNodeId });
    return result.quads.map((quad) => quad as CapturedTextPaintQuad);
  } finally {
    await session.detach();
  }
}

describeBrowser("DM-2469 authoritative affine text-fragment capture", () => {
  it("splits mixed fallback, bidi, ligature, wrap, first-letter, vertical, zoom, and nested transforms by exact UTF-16 spans", async () => {
    const context = await env!.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    try {
      const mixedText = "“Latin العربية 漢字 office affine אבג wrapped tail";
      const verticalText = "Latin العربية 漢字 office";
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}#scene{padding:50px;font:24px/31px Arial,sans-serif}
        #outer{display:inline-block;zoom:1.25;transform:rotate(13deg) scale(.91,1.08);transform-origin:71% 17%}
        #mixed{display:block;width:245px;white-space:normal;unicode-bidi:plaintext;font-variant-ligatures:common-ligatures;
          transform:skewX(7deg);transform-origin:19% 83%}
        #mixed::first-letter{font:700 42px/31px Georgia,serif;color:#c21}
        #vertical{position:absolute;left:690px;top:70px;height:250px;writing-mode:vertical-rl;
          transform:rotate(-9deg) scaleX(-1);transform-origin:23% 76%}
      </style><div id=scene><div id=outer><span id=mixed></span></div><span id=vertical></span></div>`);
      await page.locator("#mixed").evaluate((element, text) => { element.textContent = text; }, mixedText);
      await page.locator("#vertical").evaluate((element, text) => { element.textContent = text; }, verticalText);
      await page.evaluate(() => document.fonts.ready);
      const capture = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, ...VIEWPORT });

      for (const [label, expectedText, firstLetter] of [
        ["mixed", mixedText, true],
        ["vertical", verticalText, false],
      ] as const) {
        const owner = walk(capture.tree).find((element) => element.textPaintGeometry?.neutral?.textSegments
          ?.some((segment) => segment.sourceMapping?.domText === expectedText));
        const geometry = owner?.textPaintGeometry;
        expect(geometry, `${label}: exact affine geometry`).toBeDefined();
        expect(geometry!.sourceFragments.length, `${label}: physical FragmentItems`).toBeGreaterThan(2);
        expect(geometry!.sourceFragments.map((fragment) => fragment.physicalFragmentIndex), `${label}: ordered FragmentItems`)
          .toEqual(Array.from({ length: geometry!.sourceFragments.length }, (_, index) => index));
        expect(geometry!.sourceFragments.filter((fragment) => fragment.role === "ordinary").length,
          `${label}: one source span per CDP quad`).toBe(geometry!.fragments.length);
        expect(geometry!.sourceFragments.filter((fragment) => fragment.role === "first-letter").length,
          `${label}: first-letter source ownership`).toBe(firstLetter ? 1 : 0);
        if (firstLetter) {
          expect(geometry!.sourceFragments.find((fragment) => fragment.role === "first-letter")?.domUtf16Span)
            .toEqual([0, 2]);
        }
        const neutralSegments = geometry!.neutral?.textSegments ?? [];
        for (const [sourceFragmentIndex, source] of geometry!.sourceFragments.entries()) {
          const matching = neutralSegments.filter((segment) => segment.sourceMapping?.sourceTextNodeIndex === source.sourceTextNodeIndex
            && segment.sourceMapping.role === source.role
            && segment.sourceMapping.domUtf16Span[0] === source.domUtf16Span[0]
            && segment.sourceMapping.domUtf16Span[1] === source.domUtf16Span[1]);
          expect(matching, `${label}: source fragment ${sourceFragmentIndex} has one split segment`).toHaveLength(1);
          if (source.role === "ordinary") {
            const paint = geometry!.fragments.find((fragment) => fragment.sourceFragmentIndex === sourceFragmentIndex);
            expect(paint?.domUtf16Span, `${label}: paint/source span join`).toEqual(source.domUtf16Span);
            expect(neutralSegments[paint!.textSegmentIndex], `${label}: shaped record split`).toBe(matching[0]);
            expect(paint!.shapedOrigins).toHaveLength(matching[0].text.length);
            expect(paint!.shapedAdvances).toHaveLength(matching[0].text.length);
          }
        }
      }
      expect(capture.warnings.filter((warning) => warning.detail.includes("text-fragment"))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  for (const dpr of [1, 2]) {
    it(`preserves complete signed matrices and defeats the scalar collision at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
      const page = await context.newPage();
      try {
        await page.setContent(`<!doctype html><style>
          html,body{margin:0;width:100%;height:100%} #scene{padding:70px;font:22px/30px Arial,sans-serif}
          .case{display:inline-block;width:170px;margin:18px;transform-origin:0 0;white-space:nowrap}
          #translate{transform:translate(17.5px,-8.25px)}
          #scale{transform:scale(${COS_37})}
          #rotate{transform:rotate(37deg)}
          #anisotropic{translate:4px -3px;rotate:19deg;scale:-1.3 .7;transform:skewX(11deg)}
          #reflect-x{transform:scaleX(-1)} #reflect-y{transform:scaleY(-1)}
          #nested{transform:rotate(-11deg) scale(.9,1.2);transform-origin:73% 18%}
          #outer{display:inline-block;transform:rotate(23deg) scale(1.4,.75);transform-origin:11px 91%}
          #affine-3d{transform:matrix3d(1.1,.2,0,0,-.15,.8,0,0,0,0,1,0,13,-9,0,1)}
        </style><div id=scene>
          <span class=case id=identity>Identity</span><span class=case id=translate>Translate</span>
          <span class=case id=scale>CosScale</span><span class=case id=rotate>Rotation</span>
          <span class=case id=anisotropic>Anisotropic</span><span class=case id=reflect-x>ReflectX</span>
          <span class=case id=reflect-y>ReflectY</span><span id=outer><span class=case id=nested>Nested</span></span>
          <span class=case id=affine-3d>Affine3D</span>
        </div>`, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        const capture = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, ...VIEWPORT });

        const identity = matrixFor(capture.tree, "Identity");
        expect(identity.slice(0, 4)).toEqual(expect.arrayContaining([
          expect.closeTo(1, 5), expect.closeTo(0, 5), expect.closeTo(0, 5), expect.closeTo(1, 5),
        ]));
        const translation = matrixFor(capture.tree, "Translate");
        expect(translation.slice(0, 4)).toEqual([
          expect.closeTo(1, 5), expect.closeTo(0, 5), expect.closeTo(0, 5), expect.closeTo(1, 5),
        ]);
        expect(translation[4]).toBeCloseTo(17.5, 3);
        expect(translation[5]).toBeCloseTo(-8.25, 3);

        const scale = matrixFor(capture.tree, "CosScale");
        const rotate = matrixFor(capture.tree, "Rotation");
        expect(scale[0]).toBeCloseTo(rotate[0], 5);
        expect(scale[3]).toBeCloseTo(rotate[3], 5);
        expect(Math.abs(scale[1]) + Math.abs(scale[2])).toBeLessThan(1e-5);
        expect(Math.abs(rotate[1]) + Math.abs(rotate[2])).toBeGreaterThan(1);

        expect(determinant(matrixFor(capture.tree, "Anisotropic"))).toBeLessThan(0);
        expect(determinant(matrixFor(capture.tree, "ReflectX"))).toBeLessThan(0);
        expect(determinant(matrixFor(capture.tree, "ReflectY"))).toBeLessThan(0);
        expect(Math.abs(matrixFor(capture.tree, "Nested")[1])).toBeGreaterThan(0.1);
        expect(ownerFor(capture.tree, "Affine3D").transformSubtreeRaster).toBeUndefined();

        const rotationOwner = ownerFor(capture.tree, "Rotation");
        const rotationFragments = rotationOwner.textPaintGeometry!.fragments;
        const direct = await directTextQuads(page, "#rotate");
        expect(rotationFragments).toHaveLength(direct.length);
        for (let index = 0; index < direct.length; index++) {
          for (let value = 0; value < 8; value++) {
            expect(rotationFragments[index].paintQuad[value]).toBeCloseTo(direct[index][value], 4);
          }
          expect(maxMappedResidual(
            rotationFragments[index].paintMatrix,
            rotationFragments[index].neutralQuad,
            rotationFragments[index].paintQuad,
          )).toBeLessThanOrEqual(0.05);
        }
        expect(capture.warnings.filter((warning) => warning.detail.includes("text-fragment"))).toEqual([]);
      } finally {
        await context.close();
      }
    }, 90_000);
  }

  for (const dpr of [1, 2]) {
    it(`keeps zoom local while retaining wrap, RTL, vertical, and iframe fragments at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
      const page = await context.newPage();
      try {
        await page.setContent(`<!doctype html><style>
          html,body{margin:0} #scene{padding:50px;font:20px/28px Arial,sans-serif}
          #zoom-owner{zoom:1.5;position:absolute;left:60px;top:60px}
          #wrapped{display:block;width:145px;transform:rotate(37deg);transform-origin:13% 82%}
          #rtl{position:absolute;left:430px;top:80px;width:220px;direction:rtl;transform:skewY(13deg)}
          #vertical{position:absolute;left:730px;top:60px;height:230px;writing-mode:vertical-rl;transform:scaleX(-1)}
          iframe{position:absolute;left:80px;top:470px;width:400px;height:180px;border:0}
        </style><div id=scene>
          <div id=zoom-owner><span id=wrapped>Zoomed wrapping fragment geometry across lines</span></div>
          <span id=rtl>RTLmatrix</span><span id=vertical>縦書Affine</span>
          <iframe srcdoc="<style>body{margin:0;padding:30px;font:22px Arial}#inner{display:inline-block;transform:rotate(-21deg) scale(.8,1.3);transform-origin:77% 12%}</style><span id=inner>FrameAffine</span>"></iframe>
        </div>`, { waitUntil: "load" });
        await page.evaluate(() => Promise.all([document.fonts.ready, ...Array.from(document.querySelectorAll("iframe"), (frame) => frame.contentDocument!.fonts.ready)]));
        const capture = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, ...VIEWPORT });

        const wrapped = ownerFor(capture.tree, "Zoomed").textPaintGeometry!.fragments;
        expect(wrapped.length).toBeGreaterThan(1);
        expect(wrapped.map((fragment) => fragment.physicalFragmentIndex)).toEqual(
          Array.from({ length: wrapped.length }, (_, index) => index),
        );
        for (const fragment of wrapped) {
          expect(fragment.lineOrigin.effectiveZoom).toBeCloseTo(1.5, 6);
          // CSS zoom changed local layout/shaping. The later rotation remains
          // unit determinant and therefore cannot contain the zoom again.
          expect(determinant(fragment.paintMatrix)).toBeCloseTo(1, 4);
          expect(fragment.shapedOrigins).toHaveLength(ownerFor(capture.tree, "Zoomed").textSegments![fragment.textSegmentIndex].text.length);
          expect(fragment.shapedAdvances).toHaveLength(fragment.shapedOrigins.length);
        }

        const rtl = ownerFor(capture.tree, "RTLmatrix");
        expect(rtl.textPaintGeometry?.fragments[0]).toMatchObject({
          writingMode: "horizontal-tb",
          direction: "rtl",
        });
        expect(rtl.textPaintGeometry!.fragments[0].inlineOffset)
          .toBeCloseTo(rtl.textSegments![0].x + rtl.textSegments![0].width, 5);

        const vertical = ownerFor(capture.tree, "縦書Affine").textPaintGeometry!.fragments[0];
        expect(vertical.writingMode).toBe("vertical-rl");
        expect(vertical.shapedOrigins).toHaveLength("縦書Affine".length);
        expect(vertical.shapedAdvances).toHaveLength("縦書Affine".length);
        expect(ownerFor(capture.tree, "FrameAffine").textPaintGeometry?.fragments[0].affineResidual)
          .toBeLessThanOrEqual(0.05);
        expect(capture.warnings.filter((warning) => warning.detail.includes("text-fragment"))).toEqual([]);
      } finally {
        await context.close();
      }
    }, 90_000);
  }

  it("retains transform-box/origin translation and routes only a projective plane to the outer surface", async () => {
    const page = await env!.browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0} #scene{position:relative;width:100%;height:100%;font:22px/30px Arial}
        .box{position:absolute;left:130px;top:90px;box-sizing:content-box;width:180px;border:9px solid transparent;padding:13px 27px;
          transform:rotate(19deg) scale(1.2,.8);transform-origin:100% 0}
        #border{transform-box:border-box} #content{transform-box:content-box}
        #projective{position:absolute;left:120px;top:410px;perspective:320px;perspective-origin:17% 83%;transform-style:preserve-3d}
        #plane{display:inline-block;transform:rotateY(42deg) translateZ(28px);transform-origin:19% 77%}
        #flat3d{position:absolute;left:650px;top:430px;transform:matrix3d(1,.2,0,0,-.1,.9,0,0,0,0,1,0,11,-7,0,1)}
      </style><div id=scene><span class=box id=border>BorderRef</span><span class=box id=content>ContentRef</span>
        <div id=projective><span id=plane>ProjectiveText</span></div><span id=flat3d>FlatMatrix3D</span></div>`, { waitUntil: "load" });
      const capture = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, ...VIEWPORT });
      const border = ownerFor(capture.tree, "BorderRef").textPaintGeometry!.fragments[0];
      const content = ownerFor(capture.tree, "ContentRef").textPaintGeometry!.fragments[0];
      expect(border.transformBox).toBe("border-box");
      expect(content.transformBox).toBe("content-box");
      for (let index = 0; index < 4; index++) expect(border.paintMatrix[index]).toBeCloseTo(content.paintMatrix[index], 5);
      expect(Math.abs(border.paintMatrix[4] - content.paintMatrix[4])
        + Math.abs(border.paintMatrix[5] - content.paintMatrix[5])).toBeGreaterThan(1);

      const projectiveOwner = walk(capture.tree).find((node) => node.transformSubtreeRaster?.dataUri != null);
      expect(projectiveOwner?.transformSubtreeRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(projectiveOwner == null ? [] : walk(projectiveOwner.children)
        .filter((node) => node.textPaintGeometry != null)).toEqual([]);
      expect(ownerFor(capture.tree, "FlatMatrix3D").textPaintGeometry?.fragments[0].affineResidual)
        .toBeLessThanOrEqual(0.05);
      expect(ownerFor(capture.tree, "FlatMatrix3D").transformSubtreeRaster).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 90_000);
});
