#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { establishesStackingContext, gatherStackingContextChildren, paintOrderBuckets, sortChildrenByPaintOrder } from "../src/render/stacking.js";
import type { CapturedElement, CapturedStyles } from "../src/capture/types.js";

type Row = { id: string; expected: unknown; actual: unknown; pass: boolean; source: string };
const baseStyles = (): CapturedStyles => ({ position: "static", zIndex: "auto", display: "block", opacity: "1", transform: "none", transformStyle: "flat", filter: "none", mixBlendMode: "normal", maskImage: "none", clipPath: "none", isolation: "auto", overflowX: "visible", overflowY: "visible", contain: "none", willChange: "auto", float: "none" } as CapturedStyles);
const el = (id: string, styles: Partial<CapturedStyles> = {}, children: CapturedElement[] = []): CapturedElement => ({ tag: "div", text: id, x: 0, y: 0, width: 100, height: 100, styles: { ...baseStyles(), ...styles }, children } as CapturedElement);

export async function runPaintOrderOracle(): Promise<{ rows: Row[]; mutationMoved: boolean }> {
  const rows: Row[] = [];
  const creators: Array<[string, Partial<CapturedStyles>, string | undefined, boolean]> = [
    ["positioned-z", { position: "relative", zIndex: "1" }, undefined, true],
    ["fixed", { position: "fixed" }, undefined, true], ["sticky", { position: "sticky" }, undefined, true],
    ["opacity", { opacity: ".9" }, undefined, true], ["transform", { transform: "matrix(1,0,0,1,1,0)" }, undefined, true],
    ["transform-captured", { transformCreatesSc: true }, undefined, true], ["preserve-3d", { transformStyle: "preserve-3d" }, undefined, true],
    ["filter", { filter: "blur(1px)" }, undefined, true], ["blend", { mixBlendMode: "multiply" }, undefined, true],
    ["mask", { maskImage: "linear-gradient(black,transparent)" }, undefined, true], ["clip", { clipPath: "circle(50%)" }, undefined, true],
    ["isolation", { isolation: "isolate" }, undefined, true], ["contain", { contain: "paint" }, undefined, true],
    ["overflow", { overflowX: "hidden" }, undefined, true], ["will-change", { willChange: "transform" }, undefined, true],
    ["flex-item-z", { zIndex: "2" }, "flex", true], ["plain", {}, undefined, false], ["relative-auto", { position: "relative" }, undefined, false],
  ];
  for (const [id, styles, parentDisplay, expected] of creators) {
    const actual = establishesStackingContext(el(id, styles), parentDisplay);
    rows.push({ id: `creator.${id}`, expected, actual, pass: actual === expected, source: "CSS 2.1 Appendix E; Compositing/Transforms/Containment SC creation" });
  }

  const children = [
    el("positive", { position: "absolute", zIndex: "3" }), el("float", { float: "left" }),
    el("negative", { position: "absolute", zIndex: "-2" }), el("base"),
    el("auto", { position: "absolute", zIndex: "auto" }), el("zero", { position: "absolute", zIndex: "0" }),
  ];
  const buckets = paintOrderBuckets(children);
  const actualBuckets = { negative: buckets.negative.map((x) => x.text), base: buckets.base.map((x) => x.text), floats: buckets.floats.map((x) => x.text), zeroOrAuto: buckets.zeroOrAuto.map((x) => x.text), positive: buckets.positive.map((x) => x.text) };
  const expectedBuckets = { negative: ["negative"], base: ["base"], floats: ["float"], zeroOrAuto: ["auto", "zero"], positive: ["positive"] };
  rows.push({ id: "buckets.appendix-e", expected: expectedBuckets, actual: actualBuckets, pass: JSON.stringify(actualBuckets) === JSON.stringify(expectedBuckets), source: "CSS 2.1 Appendix E steps 2-7" });

  for (const [id, boundary] of [["opacity", { opacity: ".9" }], ["filter", { filter: "blur(1px)" }], ["isolation", { isolation: "isolate" }], ["mask", { maskImage: "linear-gradient(black,transparent)" }]] as const) {
    const deep = el("deep", { position: "absolute", zIndex: "999" });
    const wrapper = el("wrapper", boundary, [deep]);
    const sibling = el("sibling", { position: "absolute", zIndex: "2" });
    const hoisted = new Set<CapturedElement>();
    const flat = gatherStackingContextChildren([wrapper, sibling], hoisted);
    const order = sortChildrenByPaintOrder(flat).map((x) => x.text);
    const actual = { deepHoisted: hoisted.has(deep), top: order.at(-1) };
    const expected = { deepHoisted: false, top: "sibling" };
    rows.push({ id: `containment.${id}`, expected, actual, pass: JSON.stringify(actual) === JSON.stringify(expected), source: "atomic stacking-context containment" });
  }
  const deep = el("deep", { position: "absolute", zIndex: "999" });
  const transparentWrapper = el("wrapper", {}, [deep]);
  const sibling = el("sibling", { position: "absolute", zIndex: "2" });
  const hoisted = new Set<CapturedElement>();
  const transparentOrder = sortChildrenByPaintOrder(gatherStackingContextChildren([transparentWrapper, sibling], hoisted)).map((x) => x.text);
  rows.push({ id: "containment.non-sc-hoists", expected: { deepHoisted: true, top: "deep" }, actual: { deepHoisted: hoisted.has(deep), top: transparentOrder.at(-1) }, pass: hoisted.has(deep) && transparentOrder.at(-1) === "deep", source: "positioned descendant hoist to nearest real SC" });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 180 } });
    await page.setContent(`<style>html,body{margin:0}.root{position:relative;width:120px;height:120px;display:inline-block;margin-right:20px}.layer{position:absolute;inset:10px}</style>
      <div class=root id=plain><div id=pwrap><div class=layer id=pdeep style="z-index:999;background:red"></div></div><div class=layer id=psib style="z-index:2;background:blue"></div></div>
      <div class=root id=iso><div class=layer style="z-index:1;isolation:isolate"><div class=layer id=ideep style="z-index:999;background:red"></div></div><div class=layer id=isib style="z-index:2;background:blue"></div></div>
      <div class=root id=opacity><div class=layer style="z-index:1;opacity:.9"><div class=layer id=odeep style="z-index:999;background:red"></div></div><div class=layer id=osib style="z-index:2;background:blue"></div></div>`);
    for (const [id, x, expected] of [["plain", 60, "pdeep"], ["isolation", 200, "isib"], ["opacity", 340, "osib"]] as const) {
      const actual = await page.evaluate(({ x }) => document.elementsFromPoint(x, 60).map((node) => node.id).find((value) => /(?:deep|sib)$/.test(value)), { x });
      rows.push({ id: `browser.${id}`, expected, actual, pass: actual === expected, source: "live Chromium hit-test paint stack" });
    }
  } finally { await browser.close(); }
  const mutationMoved = establishesStackingContext(el("mutation", { opacity: ".9" })) && !establishesStackingContext(el("mutation"));
  return { rows, mutationMoved };
}

async function main(): Promise<void> {
  const report = await runPaintOrderOracle();
  const failures = report.rows.filter((row) => !row.pass);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(`paint-order oracle: ${report.rows.length - failures.length}/${report.rows.length}; mutation control ${report.mutationMoved ? "moved" : "DID NOT MOVE"}`);
  for (const failure of failures) console.log(`FAIL ${failure.id}: expected=${JSON.stringify(failure.expected)} actual=${JSON.stringify(failure.actual)}`);
  if (failures.length > 0 || !report.mutationMoved) process.exitCode = 1;
}
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
