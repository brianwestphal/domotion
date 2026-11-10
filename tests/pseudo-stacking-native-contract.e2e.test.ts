import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const PATH = "M13.75 6.75H10.25V5H15.5V10.25H13.75ZM6.75 10.25H5V15.5H10.25V13.75H6.75Z";
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}

async function purplePixels(png: Buffer): Promise<number> {
  const raw = await sharp(png).removeAlpha().raw().toBuffer();
  let count = 0;
  for (let index = 0; index < raw.length; index += 3) {
    if (raw[index] === 83 && raw[index + 1] === 58 && raw[index + 2] === 253) count++;
  }
  return count;
}

describe("native pseudo/child stacking source contract (DM-AWS6Y4)", () => {
  it("matches tied/numeric generated-child order and the in-flow after seam (DM-XWPSPP)", async () => {
    const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
    const generated = await browser.newPage({ viewport: { width: 80, height: 80 } });
    try {
      const cases = [
        ...["before", "after"].flatMap((pseudo) =>
          [1, 2, 3].map((zIndex) => ({
            name: `${pseudo}-${zIndex}`,
            pseudo,
            zIndex,
            childZ: "2",
            childPosition: "relative",
            inFlow: false,
            pseudoPosition: "absolute",
            clip: false,
            visible: pseudo === "before" ? zIndex <= 2 : zIndex < 2,
          })),
        ),
        ...["static", "relative"].map((childPosition) => ({
          name: `inflow-${childPosition}`,
          pseudo: "after",
          zIndex: "auto",
          childZ: "auto",
          childPosition,
          inFlow: true,
          pseudoPosition: "static",
          clip: false,
          visible: childPosition === "relative",
        })),
        ...["relative", "sticky"].flatMap((pseudoPosition) =>
          ["auto", "1"].map((childZ) => ({
            name: `${pseudoPosition}-after-${childZ}`,
            pseudo: "after",
            zIndex: "auto",
            childZ,
            childPosition: "relative",
            inFlow: true,
            pseudoPosition,
            clip: false,
            visible: childZ === "1",
          })),
        ),
        {
          name: "clipped-auto",
          pseudo: "after",
          zIndex: "auto",
          childZ: "1",
          childPosition: "relative",
          inFlow: false,
          pseudoPosition: "absolute",
          clip: true,
          visible: true,
        },
      ];
      for (const item of cases) {
        await page.setContent(`<!doctype html><style>
          body{margin:0;background:white}
          .host{position:relative;z-index:3;margin:20px;width:38px;height:38px;font-size:0;${item.clip ? "overflow:hidden" : ""}}
          .icon{position:${item.childPosition};z-index:${item.childZ};width:${item.clip ? 60 : 38}px;height:38px;display:inline-flex;align-items:center;justify-content:center;vertical-align:top}
          .host::${item.pseudo}{content:"";position:${item.pseudoPosition};${item.inFlow ? "display:inline-block;width:38px;height:38px;margin-left:-38px;vertical-align:top" : "inset:0"};background:rgb(245,245,255);border-radius:4px;z-index:${item.zIndex}}
          </style><div class="host"><div class="icon"><svg width="20" height="20" viewBox="0 0 20 20"><path fill="rgb(83,58,253)" d="${PATH}"/></svg></div></div>`);
        const nativeCount = await purplePixels(await page.screenshot());
        expect(nativeCount > 0, `native ${item.name}`).toBe(item.visible);
        const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
        expect(captured.warnings).toEqual([]);
        await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(captured.tree, 80, 80)}`);
        expect(await purplePixels(await generated.screenshot()), item.name).toBe(nativeCount);
      }
    } finally {
      await generated.close();
      await page.close();
    }
  }, 60_000);

  for (const contain of ["none", "layout style"]) {
    it(`retains the native positioned z-order and SVG owner with containment ${contain}`, async () => {
      const page = await browser.newPage({ viewport: { width: 80, height: 80 } });
      const generated = await browser.newPage({ viewport: { width: 80, height: 80 } });
      try {
        for (const pseudoZ of ["none", "-1", "auto", "0", "1", "2"]) {
          await page.setContent(`<!doctype html><style>
            body{margin:0;background:white}
            .host{position:relative;z-index:3;margin:20px;width:38px;height:38px;contain:${contain}}
            .icon{position:relative;z-index:1;width:38px;height:38px;display:flex;align-items:center;justify-content:center}
            .host::after{content:${pseudoZ === "none" ? "none" : '""'};position:absolute;inset:0;background:rgb(245,245,255);border-radius:4px;z-index:${pseudoZ === "none" ? "auto" : pseudoZ}}
            </style><div class="host"><div class="icon"><svg width="20" height="20" viewBox="0 0 20 20"><path fill="rgb(83,58,253)" d="${PATH}"/></svg></div></div>`);
          // Blink's stable z-order sort puts an auto/zero pseudo below the
          // positioned z1 child, but a tied/larger ::after above that child.
          const visible = ["none", "-1", "auto", "0"].includes(pseudoZ);
          expect((await purplePixels(await page.screenshot())) > 0, pseudoZ).toBe(visible);
          const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 80, height: 80 });
          expect(captured.warnings).toEqual([]);
          const nodes = walk(captured.tree);
          const svg = nodes.find((node) => node.tag === "svg");
          expect(svg).toMatchObject({ width: 20, height: 20, styles: { opacity: "1" } });
          expect(svg?.svgContent).toMatch(/fill="rgb\(83,\s*58,\s*253\)"/);
          const pseudo = nodes
            .flatMap((node) => node.pseudoFragments ?? [])
            .find((record) => record.pseudo === "::after");
          if (pseudoZ === "none") expect(pseudo).toBeUndefined();
          else {
            expect(pseudo).toMatchObject({
              status: "exact",
              paint: { position: "absolute", backgroundColor: "rgb(245, 245, 255)", opacity: 1 },
            });
            expect(pseudo?.paint.zIndex).toBe(pseudoZ === "auto" ? undefined : Number(pseudoZ));
          }
          const output = elementTreeToSvg(captured.tree, 80, 80);
          expect(output).toMatch(/fill="rgb\(83,\s*58,\s*253\)"/);
          await generated.setContent(`<style>body{margin:0}</style>${output}`);
          expect((await purplePixels(await generated.screenshot())) > 0, `rendered ${pseudoZ}`).toBe(visible);
        }
      } finally {
        await generated.close();
        await page.close();
      }
    }, 60_000);
  }
});
