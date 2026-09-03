import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { blinkPhysicalSymbolMarkerRect, type SymbolMarkerType } from "../src/render/list-marker-geometry.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 1040;
const HEIGHT = 760;

const HTML = `<!doctype html><style>
  html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white}
  body{font-family:Arial,sans-serif;color:rgb(18,28,38)}
  details{position:absolute;margin:0}
  summary{box-sizing:border-box;width:230px;min-height:48px;font-size:20px;line-height:34px;padding:3px 7px}
  summary::marker{color:rgb(221,17,34)}
  #closed{left:31.375px;top:23.625px}
  #open{left:300.25px;top:23.375px}
  #rtl{left:570.375px;top:23.625px;direction:rtl}
  #outside{left:45.25px;top:102.375px}#outside>summary{list-style-position:outside}
  #styled{left:300.375px;top:102.625px}#styled>summary::marker{font-size:31px;color:rgb(91,33,182)}
  #mixed{left:570.125px;top:102.375px}#mixed>summary{font-size:17px;line-height:51px}#mixed>summary::marker{font-size:23px}
  .vertical>summary{width:62px;height:176px;line-height:38px}
  #vrl{left:40.25px;top:205.625px}#vrl>summary{writing-mode:vertical-rl}
  #vlr{left:180.375px;top:205.25px}#vlr>summary{writing-mode:vertical-lr}
  #srl{left:320.625px;top:205.375px}#srl>summary{writing-mode:sideways-rl}
  #slr{left:460.125px;top:205.625px}#slr>summary{writing-mode:sideways-lr}
  #zoom{left:635.3px;top:220.7px;zoom:1.25}#zoom>summary{font-size:19px;line-height:33px}#zoom>summary::marker{font-size:27px}
  #nested{left:40.375px;top:430.625px}#nested details{position:relative;left:26.25px;top:8.375px}
  #exclusive-a{left:365.375px;top:430.25px}#exclusive-b{left:365.375px;top:493.25px}
  #none{left:680px;top:430px}#none>summary{list-style:none}#none>summary::before{content:"+";color:rgb(0,120,70)}
  #transparent{left:680px;top:493px}#transparent>summary::marker{color:transparent}
  #flex{left:680px;top:556px}#flex>summary{display:flex;list-style:none;justify-content:space-between}#flex>summary::before{content:"+";color:rgb(0,120,70)}
</style>
<details id="closed"><summary>closed LTR</summary></details>
<details id="open" open><summary>open LTR</summary><p>body</p></details>
<details id="rtl"><summary>RTL closed</summary></details>
<details id="outside"><summary>outside</summary></details>
<details id="styled" open><summary>styled marker</summary></details>
<details id="mixed"><summary>mixed line height</summary></details>
<details id="vrl" class="vertical" open><summary>縦書 open</summary></details>
<details id="vlr" class="vertical"><summary>縦書 closed</summary></details>
<details id="srl" class="vertical" open><summary>sideways</summary></details>
<details id="slr" class="vertical"><summary>sideways</summary></details>
<details id="zoom" open><summary>zoomed</summary></details>
<details id="nested" open><summary>nested parent</summary>
  <details><summary>nested child</summary></details>
</details>
<details id="exclusive-a" name="exclusive"><summary>exclusive A</summary></details>
<details id="exclusive-b" name="exclusive" open><summary>exclusive B</summary></details>
<details id="none"><summary>author replacement</summary></details>
<details id="transparent"><summary>transparent marker</summary></details>
<details id="flex"><summary>known flex pseudo residual</summary></details>`;

const SUMMARY_IDS = [
  "closed", "open", "rtl", "outside", "styled", "mixed", "vrl", "vlr", "srl", "slr", "zoom",
  "nested-parent", "nested-child", "exclusive-a", "exclusive-b", "none", "transparent", "flex",
] as const;

function flatten(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function rgb(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (match == null) throw new Error(`unresolved marker color: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

interface InkBounds { left: number; top: number; right: number; bottom: number; count: number }

async function inkBounds(
  png: Buffer,
  dpr: number,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number],
): Promise<InkBounds> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.floor((rect.x - 2) * dpr));
  const top = Math.max(0, Math.floor((rect.y - 2) * dpr));
  const right = Math.min(info.width - 1, Math.ceil((rect.x + rect.width + 2) * dpr));
  const bottom = Math.min(info.height - 1, Math.ceil((rect.y + rect.height + 2) * dpr));
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1, count = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const index = (y * info.width + x) * info.channels;
      const distance = Math.abs(data[index] - color[0])
        + Math.abs(data[index + 1] - color[1])
        + Math.abs(data[index + 2] - color[2]);
      if (distance > 90) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++;
    }
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY, count };
}

// This file is the dedicated release oracle, so an unavailable Chromium is a
// failed gate rather than a green skip.
const env = { browser: await launchChromium() };
afterAll(async () => closeBrowserSafely(env.browser), 15_000);
const describeBrowser = describe;

describeBrowser("source-owned summary disclosure marker (DM-2457)", () => {
  for (const dpr of [1, 2]) {
    it(`captures Blink's first-line marker and matches Chromium ink at DPR ${dpr}`, async () => {
      const context = await env.browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const generated = await context.newPage();
      try {
        await source.setContent(HTML);
        const expected = await source.screenshot();
        const capture = await captureElementTreeWithWarnings(source, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
        expect(capture.warnings.filter(({ feature }) => feature === "summary-disclosure-marker-geometry")).toEqual([]);
        const summaries = flatten(capture.tree).filter((node) => node.tag === "summary");
        expect(summaries).toHaveLength(SUMMARY_IDS.length);
        const byId = new Map(SUMMARY_IDS.map((id, index) => [id, summaries[index]]));
        const shown = ["closed", "open", "rtl", "outside", "styled", "mixed", "vrl", "vlr", "srl", "slr", "zoom", "nested-parent", "nested-child", "exclusive-a", "exclusive-b"];
        for (const id of shown) expect(byId.get(id)?.summaryMarkerGeometry, id).toBeDefined();
        for (const id of ["none", "transparent", "flex"]) expect(byId.get(id)?.summaryMarkerGeometry, id).toBeUndefined();
        expect(byId.get("closed")!.summaryMarkerGeometry).toMatchObject({ listStyleType: "disclosure-closed", listStylePosition: "inside" });
        expect(byId.get("open")!.summaryMarkerGeometry).toMatchObject({ listStyleType: "disclosure-open" });
        expect(byId.get("outside")!.summaryMarkerGeometry).toMatchObject({ listStylePosition: "outside" });
        expect(byId.get("styled")!.summaryMarkerGeometry).toMatchObject({ specifiedFontSize: 31, color: "rgb(91, 33, 182)" });
        expect(byId.get("zoom")!.summaryMarkerGeometry!.effectiveZoom).toBeCloseTo(1.25, 5);

        const svg = elementTreeToSvg(capture.tree, WIDTH, HEIGHT);
        for (const id of shown) {
          const node = byId.get(id)!;
          const isolated = elementTreeToSvg([node], WIDTH, HEIGHT);
          if (node.transformSubtreeRaster?.dataUri != null) {
            // The affine text-fragment pipeline intentionally promotes
            // sideways-lr to one Chromium-owned surface. A Linux fallback can
            // also make either leading-CJK vertical run ambiguous because CDP
            // exposes only the following Latin FragmentItem. Each surface
            // already contains the marker, so a second polygon would double-paint.
            expect(["vrl", "vlr", "slr"]).toContain(id);
            expect(isolated, `${id}: terminal Chromium surface`).toContain("<image");
          } else {
            expect(isolated, `${id}: source-owned marker route`).toContain("<polygon");
          }
        }
        await generated.setContent(`<style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:white}</style>${svg}`);
        const actual = await generated.screenshot();
        for (const id of shown) {
          const record = byId.get(id)!.summaryMarkerGeometry!;
          const symbol = blinkPhysicalSymbolMarkerRect(
            record.fragmentRect,
            record.fontAscent,
            record.specifiedFontSize,
            record.effectiveZoom,
            record.listStyleType as SymbolMarkerType,
            record.writingMode,
          );
          const [browserInk, svgInk] = await Promise.all([
            inkBounds(expected, dpr, symbol, rgb(record.color)),
            inkBounds(actual, dpr, symbol, rgb(record.color)),
          ]);
          expect(browserInk.count, `${id}: Chromium ink`).toBeGreaterThan(2);
          expect(svgInk.count, `${id}: SVG ink`).toBeGreaterThan(2);
          expect(Math.abs(svgInk.left - browserInk.left), `${id}: left edge`).toBeLessThanOrEqual(1);
          expect(Math.abs(svgInk.top - browserInk.top), `${id}: top edge`).toBeLessThanOrEqual(1);
          expect(Math.abs(svgInk.right - browserInk.right), `${id}: right edge`).toBeLessThanOrEqual(1);
          expect(Math.abs(svgInk.bottom - browserInk.bottom), `${id}: bottom edge`).toBeLessThanOrEqual(1);
          // At DPR 1 these ~13px triangles contain only ~65 fully/partially
          // selected pixels, so one antialiased boundary row is quantized to
          // more than 8%. Keep the proportional bound for larger rows while
          // allowing at most eight device pixels for the smallest symbols.
          expect(Math.abs(svgInk.count - browserInk.count), `${id}: ink area`)
            .toBeLessThanOrEqual(Math.max(8, Math.ceil(browserInk.count * 0.08)));
        }
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
