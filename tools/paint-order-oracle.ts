#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  establishesStackingContext,
  gatherStackingContextChildren,
  isFixedContainingBlock,
  isOverflowOnlySC,
  paintOrderBuckets,
  sortChildrenByPaintOrder,
} from "../src/render/stacking.js";
import type { CapturedElement, CapturedStyles } from "../src/capture/types.js";

type Row = { id: string; expected: unknown; actual: unknown; pass: boolean; source: string };
const baseStyles = (): CapturedStyles => ({ position: "static", zIndex: "auto", display: "block", opacity: "1", transform: "none", transformStyle: "flat", perspective: "none", perspectiveOrigin: "50px 50px", filter: "none", mixBlendMode: "normal", maskImage: "none", clipPath: "none", isolation: "auto", overflowX: "visible", overflowY: "visible", contain: "none", willChange: "auto", float: "none" } as CapturedStyles);
const el = (id: string, styles: Partial<CapturedStyles> = {}, children: CapturedElement[] = []): CapturedElement => ({ tag: "div", text: id, x: 0, y: 0, width: 100, height: 100, styles: { ...baseStyles(), ...styles }, children } as CapturedElement);

export async function runPaintOrderOracle(): Promise<{ rows: Row[]; mutationMoved: boolean }> {
  const rows: Row[] = [];
  const creators: Array<[string, Partial<CapturedStyles>, string | undefined, boolean]> = [
    ["positioned-z", { position: "relative", zIndex: "1" }, undefined, true],
    ["fixed", { position: "fixed" }, undefined, true], ["sticky", { position: "sticky" }, undefined, true],
    ["opacity", { opacity: ".9" }, undefined, true], ["transform", { transform: "matrix(1,0,0,1,1,0)" }, undefined, true],
    ["transform-captured", { transformCreatesSc: true }, undefined, true], ["preserve-3d", { transformStyle: "preserve-3d" }, undefined, true],
    ["perspective", { perspective: "420px", perspectiveOrigin: "20px 75px" }, undefined, true],
    ["perspective-origin-only", { perspective: "none", perspectiveOrigin: "20px 75px" }, undefined, false],
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

  // DM-2385: these three answers must move together. Blink rev 7d859f27
  // creates a stacking context through ComputedStyle::
  // CalculateIsStackingContextWithoutContainment, and a fixed containing block
  // through LayoutObject::ComputeIsFixedContainer. Overflow-only contexts are
  // pass-through in Domotion, so any source-owned transform-related reason
  // must also turn that classification off.
  for (const [id, styles, expected] of [
    ["perspective", { perspective: "420px", perspectiveOrigin: "20px 75px" }, { stacking: true, fixed: true, overflowOnly: false }],
    ["perspective-none", { perspective: "none", perspectiveOrigin: "20px 75px" }, { stacking: false, fixed: false, overflowOnly: true }],
    ["preserve-3d-flattened", { transformStyle: "preserve-3d" }, { stacking: true, fixed: true, overflowOnly: false }],
    ["will-change-perspective", { willChange: "perspective" }, { stacking: true, fixed: true, overflowOnly: false }],
    ["will-change-perspective-origin", { willChange: "perspective-origin" }, { stacking: false, fixed: false, overflowOnly: true }],
    ["static-inline-perspective", { display: "inline", perspective: "420px", transformRelatedBox: false }, { stacking: false, fixed: false, overflowOnly: true }],
    ["positioned-inline-perspective", { display: "inline", position: "relative", perspective: "420px", transformRelatedBox: false }, { stacking: true, fixed: false, overflowOnly: false }],
  ] as Array<[string, Partial<CapturedStyles>, { stacking: boolean; fixed: boolean; overflowOnly: boolean }]>) {
    const subject = el(id, styles);
    const overflowSubject = el(id, { ...styles, overflowX: "hidden", overflowY: "hidden" });
    const actual = {
      stacking: establishesStackingContext(subject),
      fixed: isFixedContainingBlock(subject),
      overflowOnly: isOverflowOnlySC(overflowSubject),
    };
    rows.push({
      id: `ownership.${id}`,
      expected,
      actual,
      pass: JSON.stringify(actual) === JSON.stringify(expected),
      source: "Chromium 7d859f27 computed_style.{h,cc}; layout_object.cc::ComputeIsFixedContainer",
    });
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

    await page.setViewportSize({ width: 800, height: 500 });
    await page.setContent(`<style>html,body{margin:0}.owner{position:absolute;width:80px;height:50px;border:3px solid;overflow:hidden}.pin{position:fixed;left:7px;top:9px;width:5px;height:5px}</style>
      <div class=owner id=perspective style="left:50px;top:40px;perspective:420px;perspective-origin:15% 70%"><i class=pin></i></div>
      <div class=owner id=none style="left:150px;top:100px;perspective:none;perspective-origin:15% 70%"><i class=pin></i></div>
      <div class=owner id=preserve style="left:250px;top:160px;transform-style:preserve-3d"><i class=pin></i></div>
      <div class=owner id=hinted style="left:350px;top:220px;will-change:perspective"><i class=pin></i></div>
      <div class=owner id=origin style="left:450px;top:280px;perspective-origin:15% 70%"><i class=pin></i></div>
      <div style="position:absolute;left:550px;top:340px;width:100px;height:60px;overflow:hidden"><span id=inline style="perspective:420px">inline<i class=pin></i></span></div>
      <div style="position:absolute;left:680px;top:340px;width:100px;height:40px"><span id=inlineStack style="position:relative;perspective:420px">x<i id=inlineDeep style="position:absolute;left:0;top:0;width:30px;height:30px;background:red;z-index:999"></i></span><b id=inlineCover style="position:absolute;left:0;top:0;width:30px;height:30px;background:blue;z-index:1"></b></div>
      <div style="position:absolute;left:680px;top:390px;width:100px;height:40px"><span id=staticInlineStack style="perspective:420px">x<i id=staticInlineDeep style="position:absolute;left:0;top:0;width:30px;height:30px;background:red;z-index:999"></i></span><b id=staticInlineCover style="position:absolute;left:0;top:0;width:30px;height:30px;background:blue;z-index:1"></b></div>`);
    const actualFixedOwnership = await page.evaluate(() => {
      const result: Array<Array<number | string>> = [];
      for (const id of ["perspective", "none", "preserve", "hinted", "origin"]) {
        const owner = document.getElementById(id)!;
        const pin = owner.querySelector(".pin")!.getBoundingClientRect();
        const style = getComputedStyle(owner);
        result.push([pin.left, pin.top, style.perspective, style.perspectiveOrigin, style.transformStyle, style.willChange]);
      }
      return result;
    });
    const expectedFixedOwnership = [
      [60, 52, "420px", "12.8906px 39.1875px", "flat", "auto"],
      [7, 9, "none", "12.8906px 39.1875px", "flat", "auto"],
      [260, 172, "none", "43px 28px", "preserve-3d", "auto"],
      [360, 232, "none", "43px 28px", "flat", "perspective"],
      [7, 9, "none", "12.8906px 39.1875px", "flat", "auto"],
    ];
    rows.push({
      id: "browser.perspective-fixed-ownership",
      expected: expectedFixedOwnership,
      actual: actualFixedOwnership,
      pass: JSON.stringify(actualFixedOwnership) === JSON.stringify(expectedFixedOwnership),
      source: "live Chromium fixed-position geometry + computed perspective/origin",
    });
    const inlineFixedPosition = await page.locator("#inline .pin").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return [rect.left, rect.top];
    });
    rows.push({
      id: "browser.inline-perspective-does-not-own-fixed",
      expected: [7, 9],
      actual: inlineFixedPosition,
      pass: JSON.stringify(inlineFixedPosition) === JSON.stringify([7, 9]),
      source: "live Chromium non-box inline perspective control",
    });
    const inlineStackTop = await page.evaluate(() => document.elementsFromPoint(690, 350)
      .map((node) => node.id)
      .find((id) => id === "inlineDeep" || id === "inlineCover"));
    rows.push({
      id: "browser.positioned-inline-perspective-stacks-without-fixed-ownership",
      expected: "inlineCover",
      actual: inlineStackTop,
      pass: inlineStackTop === "inlineCover",
      source: "live Chromium ComputedStyle stacking + LayoutInline paint-layer control",
    });
    const staticInlineStackTop = await page.evaluate(() => document.elementsFromPoint(690, 400)
      .map((node) => node.id)
      .find((id) => id === "staticInlineDeep" || id === "staticInlineCover"));
    rows.push({
      id: "browser.static-inline-perspective-has-no-paint-layer",
      expected: "staticInlineDeep",
      actual: staticInlineStackTop,
      pass: staticInlineStackTop === "staticInlineDeep",
      source: "live Chromium LayoutInline::LayerTypeRequired negative control",
    });
    const willChangeOwnership = await page.evaluate(() => {
      const values = [
        "transform", "transform-style", "perspective", "translate", "rotate",
        "scale", "offset-path", "offset-position", "offset-distance",
        "offset-rotate", "transform-origin", "perspective-origin", "scroll-position",
      ];
      const owner = document.createElement("div");
      owner.style.cssText = "position:absolute;left:50px;top:420px;width:50px;height:50px";
      const pin = document.createElement("i");
      pin.style.cssText = "position:fixed;left:7px;top:9px;width:5px;height:5px";
      owner.append(pin);
      document.body.append(owner);
      const result = values.map((value) => {
        owner.style.willChange = value;
        const rect = pin.getBoundingClientRect();
        return [value, rect.left, rect.top];
      });
      owner.remove();
      return result;
    });
    const expectedWillChangeOwnership = [
      ...["transform", "transform-style", "perspective", "translate", "rotate", "scale", "offset-path", "offset-position"]
        .map((value) => [value, 57, 429]),
      ...["offset-distance", "offset-rotate", "transform-origin", "perspective-origin", "scroll-position"]
        .map((value) => [value, 7, 9]),
    ];
    rows.push({
      id: "browser.will-change-transform-related-property-set",
      expected: expectedWillChangeOwnership,
      actual: willChangeOwnership,
      pass: JSON.stringify(willChangeOwnership) === JSON.stringify(expectedWillChangeOwnership),
      source: "live Chromium HasWillChangeAnyTransformProperty fixed-position geometry",
    });
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
