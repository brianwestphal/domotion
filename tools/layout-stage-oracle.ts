/**
 * Generated Chromium/Domotion text-layout stage oracle.
 *
 * Chromium leg: direct DOM Range origins for each source code point.
 * Domotion leg: textSegments emitted by the production CAPTURE_SCRIPT.
 * The two paths share only the live DOM; no expected record is cloned into the
 * actual record. Blink source anchor: chromium 7d859f27, core/layout/inline and
 * platform/fonts/shaping. Capture representation boundary: docs 116 and 120.
 */
import { writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import type { CapturedElement, TextSegment } from "../src/capture/types.js";
import { fingerprintComplete, parityEnvironment } from "./parity-environment.js";

const output = (() => { const i = process.argv.indexOf("--json"); return i >= 0 ? process.argv[i + 1] : undefined; })();
const tolerance = Number((() => { const i = process.argv.indexOf("--tolerance"); return i >= 0 ? process.argv[i + 1] : "0.001"; })());
const skipControl = process.argv.includes("--skip-negative-control");

type Axis = "direction" | "writingMode" | "spacing" | "wrap" | "traits" | "transform";
interface Fixture {
  id: string;
  css: string;
  html: string;
  axes: Record<Axis, string>;
  normalizeScale?: number;
  metamorphicGroup?: string;
}
interface Origin { char: string; x: number; y: number }
interface Geometry { box: { width: number; height: number }; origins: Origin[] }

const axisValues: Record<Axis, string[]> = {
  direction: ["ltr", "rtl"],
  writingMode: ["horizontal-tb", "vertical-rl"],
  spacing: ["normal", "spaced"],
  wrap: ["wide", "narrow"],
  traits: ["regular", "synthetic"],
  transform: ["none", "scaled"],
};

function cssFor(axes: Record<Axis, string>): string {
  const vertical = axes.writingMode !== "horizontal-tb";
  return [
    "position:absolute;left:40px;top:40px",
    axes.traits === "synthetic" ? "font:italic 700 19px/27px sans-serif" : "font:19px/27px sans-serif",
    `direction:${axes.direction}`,
    `writing-mode:${axes.writingMode}`,
    axes.spacing === "spaced" ? "letter-spacing:1.25px;word-spacing:3px" : "letter-spacing:normal;word-spacing:normal",
    vertical
      ? `height:${axes.wrap === "narrow" ? 72 : 220}px;width:80px`
      : `width:${axes.wrap === "narrow" ? 116 : 300}px`,
    axes.transform === "scaled" ? "transform:scale(1.125);transform-origin:0 0" : "transform:none",
  ].join(";");
}

// Transition coverage: the base row, every isolated non-default state, then
// every pair of non-default axis states. This is a covering array rather than
// the old five hand-picked examples, while remaining cheap enough for CI.
const defaults = Object.fromEntries(Object.entries(axisValues).map(([axis, values]) => [axis, values[0]])) as Record<Axis, string>;
const axes = Object.keys(axisValues) as Axis[];
const matrixAssignments: Array<Record<Axis, string>> = [{ ...defaults }];
for (const axis of axes) {
  matrixAssignments.push({ ...defaults, [axis]: axisValues[axis][1] });
}
for (let i = 0; i < axes.length; i++) {
  for (let j = i + 1; j < axes.length; j++) {
    matrixAssignments.push({ ...defaults, [axes[i]]: axisValues[axes[i]][1], [axes[j]]: axisValues[axes[j]][1] });
  }
}
const fixtures: Fixture[] = matrixAssignments.map((assignment, i) => ({
  id: `matrix-${String(i).padStart(2, "0")}`,
  css: cssFor(assignment),
  html: "office A\u00adV e\u0301 אבג 12",
  axes: assignment,
}));

const metaAxes = { ...defaults };
const metaCss = cssFor(metaAxes);
fixtures.push(
  { id: "meta-plain", css: metaCss, html: "AV office", axes: metaAxes, metamorphicGroup: "inline-equivalence" },
  { id: "meta-neutral-wrapper", css: metaCss, html: "<span>AV office</span>", axes: metaAxes, metamorphicGroup: "inline-equivalence" },
  { id: "meta-node-split", css: metaCss, html: "<span>AV </span><span>office</span>", axes: metaAxes, metamorphicGroup: "inline-equivalence" },
  { id: "meta-longhand", css: metaCss.replace("font:19px/27px sans-serif", "font-family:sans-serif;font-size:19px;line-height:27px;font-style:normal;font-weight:400"), html: "AV office", axes: metaAxes, metamorphicGroup: "inline-equivalence" },
  { id: "meta-translated", css: `${metaCss};transform:translate(37px,23px)`, html: "AV office", axes: metaAxes, metamorphicGroup: "inline-equivalence" },
  { id: "meta-scale-2x", css: `${metaCss};transform:scale(2);transform-origin:0 0`, html: "AV office", axes: metaAxes, normalizeScale: 2, metamorphicGroup: "inline-equivalence" },
);

function codePointEntries(text: string): Array<{ char: string; start: number; end: number }> {
  const out = [];
  for (let start = 0; start < text.length;) {
    const size = text.codePointAt(start)! > 0xFFFF ? 2 : 1;
    out.push({ char: text.slice(start, start + size), start, end: start + size });
    start += size;
  }
  return out;
}

async function chromiumGeometry(page: Page, selector: string, scale: number): Promise<Geometry> {
  return page.locator(selector).evaluate((el, s) => {
    const box = el.getBoundingClientRect();
    const origins: Origin[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let start = 0; start < text.length;) {
        const size = text.codePointAt(start)! > 0xFFFF ? 2 : 1;
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + size);
        const rect = range.getBoundingClientRect();
        const char = text.slice(start, start + size);
        // Whitespace has no glyph origin for the SVG renderer to consume.
        // Range can return a nonzero advance (and, at bidi boundaries, the
        // same origin as a neighboring glyph), while capture intentionally
        // trims it at a segment edge. Compare painted characters only.
        if (!/^\s+$/u.test(char) && !(rect.width === 0 && rect.height === 0)) {
          origins.push({ char, x: (rect.left - box.left) / s, y: (rect.top - box.top) / s });
        }
        start += size;
      }
    }
    return { box: { width: box.width / s, height: box.height / s }, origins };
  }, scale);
}

function capturedGeometry(tree: CapturedElement[], box: { x: number; y: number }, scale: number): Geometry {
  const origins: Origin[] = [];
  const visitSegment = (seg: TextSegment): void => {
    for (const entry of codePointEntries(seg.sourceText ?? seg.text)) {
      if (/^\s+$/u.test(entry.char)) continue;
      if (seg.verticalWritingMode != null) {
        const y = seg.yOffsets?.[entry.start];
        if (y != null) origins.push({ char: entry.char, x: (seg.x - box.x) / scale, y: (y - box.y) / scale });
      } else {
        const x = seg.xOffsets?.[entry.start];
        if (x != null) origins.push({ char: entry.char, x: (x - box.x) / scale, y: (seg.y - box.y) / scale });
      }
    }
  };
  const visit = (element: CapturedElement): void => {
    for (const seg of element.textSegments ?? []) visitSegment(seg);
    for (const child of element.children ?? []) visit(child);
  };
  for (const element of tree) visit(element);
  const root = tree[0];
  return {
    box: { width: (root?.width ?? 0) / scale, height: (root?.height ?? 0) / scale },
    origins,
  };
}

function geometryDelta(expected: Geometry, actual: Geometry): number {
  if (expected.origins.length !== actual.origins.length) return Infinity;
  let delta = 0;
  for (let i = 0; i < expected.origins.length; i++) {
    if (expected.origins[i].char !== actual.origins[i].char) return Infinity;
    delta = Math.max(delta, Math.abs(expected.origins[i].x - actual.origins[i].x), Math.abs(expected.origins[i].y - actual.origins[i].y));
  }
  return delta;
}

function signature(geometry: Geometry): string {
  return JSON.stringify({
    origins: geometry.origins.map((o) => [o.char, o.x.toFixed(3), o.y.toFixed(3)]),
  });
}

function metamorphicDelta(baseExpected: Geometry, variantExpected: Geometry, baseActual: Geometry, variantActual: Geometry): number {
  const lists = [baseExpected.origins, variantExpected.origins, baseActual.origins, variantActual.origins];
  if (!lists.every((list) => list.length === lists[0].length)) return Infinity;
  let delta = 0;
  for (let i = 0; i < lists[0].length; i++) {
    if (!lists.every((list) => list[i].char === lists[0][i].char)) return Infinity;
    const expectedDx = variantExpected.origins[i].x - baseExpected.origins[i].x;
    const expectedDy = variantExpected.origins[i].y - baseExpected.origins[i].y;
    const actualDx = variantActual.origins[i].x - baseActual.origins[i].x;
    const actualDy = variantActual.origins[i].y - baseActual.origins[i].y;
    delta = Math.max(delta, Math.abs(expectedDx - actualDx), Math.abs(expectedDy - actualDy));
  }
  return delta;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 900, height: 700 } });
await page.setContent(`<style>body{margin:0}.probe{margin:0;padding:0;border:0}</style>${fixtures.map((f) => `<div class="probe" id="${f.id}" style="${f.css}">${f.html}</div>`).join("")}`);
const chromiumVersion = browser.version();
const records = [];
const expectedById = new Map<string, Geometry>();
const capturedById = new Map<string, Geometry>();
let mismatches = 0;
for (const fixture of fixtures) {
  const selector = `#${fixture.id}`;
  const box = await page.locator(selector).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const expected = await chromiumGeometry(page, selector, fixture.normalizeScale ?? 1);
  const raw = await page.evaluate(`(${CAPTURE_SCRIPT})({sel:${JSON.stringify(selector)},vp:{x:0,y:0,width:900,height:700},cof:""})`) as { tree: CapturedElement[] };
  const actual = capturedGeometry(raw.tree, box, fixture.normalizeScale ?? 1);
  expectedById.set(fixture.id, expected);
  capturedById.set(fixture.id, actual);
  const delta = geometryDelta(expected, actual);
  if (delta > tolerance) mismatches++;
  records.push({ id: fixture.id, axes: fixture.axes, expected, actual, maxAbsDeltaCssPx: delta, pass: delta <= tolerance });
}

const transitionControls = axes.map((axis) => {
  const changed = records.filter((record) => record.axes[axis] !== defaults[axis]);
  const moved = changed.filter((record) => signature(record.actual) !== signature(records[0].actual)).length;
  return { axis, exercisedRows: changed.length, movedRows: moved, moved: moved > 0 };
});
const baseMeta = capturedById.get("meta-plain")!;
const baseMetaExpected = expectedById.get("meta-plain")!;
const metamorphic = fixtures.filter((f) => f.metamorphicGroup != null && f.id !== "meta-plain").map((fixture) => {
  const actual = capturedById.get(fixture.id)!;
  const expected = expectedById.get(fixture.id)!;
  const delta = metamorphicDelta(baseMetaExpected, expected, baseMeta, actual);
  return { id: fixture.id, group: fixture.metamorphicGroup, maxAbsDeltaCssPx: delta, pass: delta <= tolerance };
});
const movementProven = !skipControl && transitionControls.every((control) => control.moved);
const metamorphicAgreement = metamorphic.every((row) => row.pass);
await browser.close();

const environment = parityEnvironment({
  chromium: chromiumVersion, launchFlags: [], deviceScaleFactor: 1, zoom: 1,
  writingMode: "generated-matrix", direction: "generated-matrix",
  corpusIdentity: `layout-stage-v3:${fixtures.length}`, sampleIdentity: "pairwise-axis-covering-array+metamorphic-equivalences",
});
const completeEnvironment = fingerprintComplete(environment);
const verdict = !completeEnvironment || !movementProven ? "verdict-withheld"
  : mismatches === 0 && metamorphicAgreement ? "exact-logical-agreement" : "logical-mismatch";
const report = {
  schemaVersion: 3,
  stage: "layout",
  verdict,
  environment,
  completeEnvironment,
  movementProven,
  metamorphicAgreement,
  chromium: chromiumVersion,
  toleranceCssPx: tolerance,
  generatedRows: matrixAssignments.length,
  metamorphicRows: metamorphic.length,
  mismatches,
  transitionControls,
  metamorphic,
  records,
  rasterization: { status: "out-of-scope", reason: "Skia versus consumer SVG rasterizer" },
};
if (output != null) writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Layout stage oracle: ${records.length} capture rows, ${metamorphic.length} metamorphic rows, ${mismatches} logical mismatches`);
console.log(`Transition controls: ${transitionControls.map((c) => `${c.axis}=${c.movedRows}/${c.exercisedRows}`).join(", ")}`);
if (output != null) console.log(`wrote ${output}`);
if (mismatches > 0 || !metamorphicAgreement || !completeEnvironment || !movementProven) process.exitCode = 1;
