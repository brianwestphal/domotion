#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { cssTransformToSvg } from "../src/render/transforms.js";
import { boxReflectionTransform, parseBoxReflection } from "../src/render/element-tree-to-svg.js";
import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";

type Point = { x: number; y: number };
type Row = { id: string; expected: unknown; actual: unknown; maxAbsDelta: number; pass: boolean; source: string };
const TOLERANCE = 0.02;

function delta(a: Point[], b: Point[]): number {
  if (a.length !== b.length) return Infinity;
  return Math.max(0, ...a.flatMap((p, i) => [Math.abs(p.x - b[i].x), Math.abs(p.y - b[i].y)]));
}

function hasTransformRaster(elements: CapturedElement[]): boolean {
  return elements.some((element) => element.transformSubtreeRaster?.dataUri != null || hasTransformRaster(element.children));
}

export async function runTransformGeometryOracle(): Promise<{ rows: Row[]; mutationMoved: boolean }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const cases = [
      { id: "rotate-center", transform: "rotate(31deg)", origin: "50% 50%", x: 40, y: 35, w: 130, h: 80 },
      { id: "rotate-top-left", transform: "rotate(-27deg)", origin: "0 0", x: 230, y: 45, w: 110, h: 95 },
      { id: "scale-offset", transform: "scale(1.35,.65)", origin: "20px 70px", x: 410, y: 30, w: 150, h: 100 },
      { id: "skew-origin", transform: "skew(18deg,-11deg)", origin: "80% 25%", x: 620, y: 55, w: 120, h: 90 },
      { id: "matrix-translate", transform: "matrix(.8,.3,-.2,1.1,23,-17)", origin: "33px 44px", x: 90, y: 220, w: 170, h: 75 },
    ];
    await page.setContent(`<style>html,body{margin:0}.box{position:absolute;background:#2463eb}</style>${cases.map((c) => `<div id="${c.id}" class="box" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;transform:${c.transform};transform-origin:${c.origin}"></div>`).join("")}<div id="p3" style="position:absolute;left:300px;top:300px;width:240px;height:180px;background:#eee;perspective:420px;transform-style:preserve-3d"><div style="width:180px;height:120px;background:#e33;transform:rotateY(48deg) translateZ(35px)"></div></div><div id="a3" style="position:absolute;left:620px;top:330px;width:120px;height:80px;background:#2a6;transform:scale3d(1.2,.8,1)"></div>`);
    const rows: Row[] = [];
    for (const test of cases) {
      const live = await page.locator(`#${test.id}`).evaluate((element) => {
        const points = [[0, 0], [(element as HTMLElement).offsetWidth, 0], [(element as HTMLElement).offsetWidth, (element as HTMLElement).offsetHeight], [0, (element as HTMLElement).offsetHeight]];
        return points.map(([x, y]) => {
          const marker = document.createElement("i");
          marker.style.cssText = `position:absolute;width:0;height:0;left:${x}px;top:${y}px`;
          element.appendChild(marker);
          const rect = marker.getBoundingClientRect();
          marker.remove();
          return { x: rect.left, y: rect.top };
        });
      });
      const computed = await page.locator(`#${test.id}`).evaluate((element) => {
        const style = getComputedStyle(element);
        return { transform: style.transform, origin: style.transformOrigin.split(/\s+/).map(Number.parseFloat) };
      });
      const svgTransform = cssTransformToSvg(computed.transform, test.x + computed.origin[0], test.y + computed.origin[1]);
      const actual = await page.evaluate(({ svgTransform, test }) => {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        const group = document.createElementNS(ns, "g");
        group.setAttribute("transform", svgTransform);
        svg.appendChild(group); document.body.appendChild(svg);
        const matrix = group.getCTM()!;
        const points = [[test.x, test.y], [test.x + test.w, test.y], [test.x + test.w, test.y + test.h], [test.x, test.y + test.h]].map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
        svg.remove(); return points;
      }, { svgTransform, test });
      const maxAbsDelta = delta(live, actual);
      rows.push({ id: `affine.${test.id}`, expected: live, actual, maxAbsDelta, pass: maxAbsDelta <= TOLERANCE, source: "CSS Transforms matrix + transform-origin composition" });
    }

    const tree = await captureElementTree(page, "#p3", { x: 0, y: 0, width: 900, height: 700 });
    const raster = hasTransformRaster(tree);
    rows.push({ id: "projective.preserve-3d-raster-boundary", expected: true, actual: raster, maxAbsDelta: raster ? 0 : Infinity, pass: raster, source: "Blink projective quad; SVG affine representation boundary" });
    const affine3dTree = await captureElementTree(page, "#a3", { x: 0, y: 0, width: 900, height: 700 });
    const affine3dRaster = hasTransformRaster(affine3dTree);
    rows.push({ id: "projective.affine-matrix3d-stays-vector", expected: false, actual: affine3dRaster, maxAbsDelta: affine3dRaster ? Infinity : 0, pass: !affine3dRaster, source: "fourth-corner affine residual classification" });

    for (const [direction, offset] of [["below", "12px"], ["above", "25%"], ["right", "7px"], ["left", "10%"]] as const) {
      const spec = parseBoxReflection(`${direction} ${offset}`, 120, 80)!;
      const actual = boxReflectionTransform(spec, 30, 40, 120, 80);
      const n = direction === "below" ? 252 : direction === "above" ? 60 : direction === "right" ? 307 : 48;
      const expected = direction === "below" || direction === "above" ? `matrix(1 0 0 -1 0 ${n})` : `matrix(-1 0 0 1 ${n} 0)`;
      rows.push({ id: `reflection.${direction}`, expected, actual, maxAbsDelta: expected === actual ? 0 : Infinity, pass: expected === actual, source: "FEBoxReflect direction/offset mapping" });
    }
    const correct = rows[0].actual as Point[];
    const unpivoted = [{ x: cases[0].x, y: cases[0].y }, { x: cases[0].x + cases[0].w, y: cases[0].y }, { x: cases[0].x + cases[0].w, y: cases[0].y + cases[0].h }, { x: cases[0].x, y: cases[0].y + cases[0].h }];
    return { rows, mutationMoved: delta(correct, unpivoted) > 1 };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const report = await runTransformGeometryOracle();
  const failures = report.rows.filter((row) => !row.pass);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(`transform geometry oracle: ${report.rows.length - failures.length}/${report.rows.length}; mutation control ${report.mutationMoved ? "moved" : "DID NOT MOVE"}`);
  for (const failure of failures) console.log(`FAIL ${failure.id}: delta=${failure.maxAbsDelta}`);
  if (failures.length > 0 || !report.mutationMoved) process.exitCode = 1;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
