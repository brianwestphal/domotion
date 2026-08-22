#!/usr/bin/env tsx
/** Live Chromium validation for the source-transcribed paint geometry oracle. */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { blinkCornerLine } from "./paint-geometry-oracle.js";

const SOURCE_REVISION = "chromium:7d859f271cbda744098ac69f44978d4edfa62be3";
const DPR = 4;
const require = createRequire(import.meta.url);
const playwrightVersion = (require("@playwright/test/package.json") as { version: string }).version;

export interface BrowserPaintProbe {
  id: string;
  source: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

function gradientParameter(point: { x: number; y: number }, line: ReturnType<typeof blinkCornerLine>): number {
  const dx = line.p1.x - line.p0.x, dy = line.p1.y - line.p0.y;
  return ((point.x - line.p0.x) * dx + (point.y - line.p0.y) * dy) / (dx * dx + dy * dy);
}

export async function runBrowserPaintOracle(): Promise<{ sourceRevision: string; chromiumVersion: string; playwrightVersion: string; platform: string; architecture: string; deviceScaleFactor: number; probes: BrowserPaintProbe[]; verdict: string }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 1680 }, deviceScaleFactor: DPR });
    await page.setContent(`<!doctype html><style>
      * { box-sizing:border-box } html,body { margin:0; width:360px; height:1680px; background:white }
      #gradient { position:absolute; left:20px; top:20px; width:300px; height:100px; background:linear-gradient(to top right,#000 0 50%,#fff 50% 100%) }
      #clip { position:absolute; left:20px; top:160px; width:200px; height:120px; border:10px solid transparent; padding:20px; background:#000; clip-path:content-box }
      #mask { position:absolute; left:20px; top:330px; width:200px; height:80px; background:#000; mask-image:linear-gradient(to right,#000 0 50%,transparent 50% 100%); mask-size:40px 80px; mask-position:10px 0; mask-repeat:repeat }
      #negative-radial { position:absolute; left:20px; top:430px; width:200px; height:200px; background:repeating-radial-gradient(circle 100px,#000 -30px -20px,#fff -20px -10px) }
      #conic { position:absolute; left:20px; top:650px; width:160px; height:160px; background:conic-gradient(from 90deg at 25% 75%,#000 0 25%,#fff 25% 50%,#000 50% 75%,#fff 75% 100%) }
      svg.paint { position:absolute;left:20px;width:200px;height:120px;overflow:visible }
      svg.paint > rect { fill:#000;stroke:#000;stroke-width:20px }
      #svg-fill { top:830px } #svg-stroke { top:970px } #svg-view { top:1110px }
      #svg-fill rect { clip-path:circle(20% at 0% 50%) fill-box }
      #svg-stroke rect { clip-path:circle(20% at 0% 50%) stroke-box }
      #svg-view rect { clip-path:circle(20% at 0% 50%) view-box }
      #html-url { position:absolute;left:20px;top:1250px;width:200px;height:100px;border:20px solid #000;background:#000;clip-path:url(#html-url-clip) }
      #svg-url { top:1390px }
      #html-object-url { position:absolute;left:20px;top:1540px;width:200px;height:100px;clip-path:url(#html-object-clip) }
      #html-object-url > i { position:absolute;left:80px;top:20px;width:80px;height:60px;background:#000 }
    </style><svg width="0" height="0" aria-hidden="true"><defs><clipPath id="html-url-clip"><rect width="30" height="100"/></clipPath><clipPath id="html-object-clip" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath><clipPath id="svg-url-clip" clipPathUnits="objectBoundingBox"><rect width=".25" height="1"/></clipPath></defs></svg><div id="gradient"></div><div id="clip"></div><div id="mask"></div><div id="negative-radial"></div><div id="conic"></div><svg class="paint" id="svg-fill" viewBox="0 0 200 120"><rect x="60" y="30" width="80" height="40"/></svg><svg class="paint" id="svg-stroke" viewBox="0 0 200 120"><rect x="60" y="30" width="80" height="40"/></svg><svg class="paint" id="svg-view" viewBox="0 0 200 120"><rect x="60" y="30" width="80" height="40"/></svg><div id="html-url"></div><svg class="paint" id="svg-url" viewBox="0 0 200 120"><rect x="60" y="30" width="80" height="40" clip-path="url(#svg-url-clip)"/></svg><div id="html-object-url"><i></i></div>`);
    const png = await page.screenshot();
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const luminanceAt = (cssX: number, cssY: number): number => {
      const cx = Math.round(cssX * DPR), cy = Math.round(cssY * DPR);
      let total = 0, count = 0;
      for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
        const i = (y * info.width + x) * info.channels;
        total += (data[i] + data[i + 1] + data[i + 2]) / 3;
        count++;
      }
      return total / count;
    };

    const line = blinkCornerLine("top-right", 0, 0, 300, 100);
    const oldDirect = { p0: { x: 0, y: 100 }, p1: { x: 300, y: 0 } };
    const candidates: Array<{ x: number; y: number; expected: "black" | "white" }> = [];
    for (let y = 8; y < 92; y += 7) for (let x = 8; x < 292; x += 9) {
      const sourceT = gradientParameter({ x, y }, line);
      const oldT = gradientParameter({ x, y }, oldDirect);
      if ((sourceT < 0.45 && oldT > 0.55) || (sourceT > 0.55 && oldT < 0.45)) candidates.push({ x, y, expected: sourceT < 0.5 ? "black" : "white" });
    }
    const discriminators = [...candidates.filter((point) => point.expected === "black").slice(0, 4), ...candidates.filter((point) => point.expected === "white").slice(0, 4)];
    const gradientActual = discriminators.map((point) => ({ ...point, luminance: luminanceAt(20 + point.x, 20 + point.y) }));
    const gradientPass = gradientActual.length === 8 && gradientActual.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const clipSamples = [
      { x: 49, y: 220, expected: "white" }, { x: 51, y: 220, expected: "black" },
      { x: 189, y: 220, expected: "black" }, { x: 191, y: 220, expected: "white" },
      { x: 100, y: 189, expected: "white" }, { x: 100, y: 191, expected: "black" },
      { x: 100, y: 249, expected: "black" }, { x: 100, y: 251, expected: "white" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, point.y) }));
    const clipPass = clipSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const maskSamples = [
      { x: 25, expected: "white" }, { x: 35, expected: "black" }, { x: 45, expected: "black" }, { x: 55, expected: "white" },
      { x: 65, expected: "white" }, { x: 75, expected: "black" }, { x: 95, expected: "white" }, { x: 115, expected: "black" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, 370) }));
    const maskPass = maskSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    // Blink shifts the source [-30,-10] radius interval by two 20px periods
    // to [10,30]. These radii therefore cross black/white/black bands; the
    // retired SVG-side clamp collapses both source radii to zero.
    const radialSamples = [
      { radius: 15, expected: "black" },
      { radius: 25, expected: "white" },
      { radius: 35, expected: "black" },
    ].map((point) => ({ ...point, luminance: luminanceAt(120 + point.radius, 530) }));
    const radialPass = radialSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const conicSamples = [
      { x: 80, y: 790, expected: "black" },
      { x: 40, y: 790, expected: "white" },
      { x: 40, y: 750, expected: "black" },
      { x: 80, y: 750, expected: "white" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, point.y) }));
    const conicPass = conicSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const svgBoxSamples = [
      { x: 90, y: 880, expected: "black" },
      { x: 75, y: 1020, expected: "black" },
      { x: 90, y: 1020, expected: "white" },
      { x: 75, y: 1160, expected: "white" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, point.y) }));
    const svgBoxPass = svgBoxSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const htmlUrlSamples = [
      { x: 25, y: 1300, expected: "black" },
      { x: 55, y: 1300, expected: "white" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, point.y) }));
    const htmlUrlPass = htmlUrlSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const svgUrlSamples = [
      { x: 98, y: 1450, expected: "black" },
      { x: 102, y: 1450, expected: "white" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, point.y) }));
    const svgUrlPass = svgUrlSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const htmlObjectUrlSamples = [
      { x: 110, y: 1580, expected: "black" },
      { x: 130, y: 1580, expected: "white" },
    ].map((point) => ({ ...point, luminance: luminanceAt(point.x, point.y) }));
    const htmlObjectUrlPass = htmlObjectUrlSamples.every((point) => point.expected === "black" ? point.luminance < 40 : point.luminance > 215);

    const urlSyntax = await page.evaluate(() => {
      const boxes = ["content-box", "padding-box", "border-box", "margin-box", "fill-box", "stroke-box", "view-box"];
      const rows: Array<{ owner: string; value: string; supported: boolean; specified: string; computed: string }> = [];
      for (const owner of ["html", "svg"]) {
        for (const value of ["url(#html-url-clip)", ...boxes.flatMap((box) => [`url(#html-url-clip) ${box}`, `${box} url(#html-url-clip)`])]) {
          const element = owner === "html"
            ? document.createElement("div")
            : document.createElementNS("http://www.w3.org/2000/svg", "rect");
          element.setAttribute("style", `clip-path:${value}`);
          document.body.appendChild(element);
          rows.push({ owner, value, supported: CSS.supports("clip-path", value), specified: (element as HTMLElement).style.clipPath, computed: getComputedStyle(element).clipPath });
          element.remove();
        }
      }
      return rows;
    });
    const urlSyntaxPass = urlSyntax.every((row) => row.value === "url(#html-url-clip)"
      ? row.supported && row.specified !== "" && /^url\(/.test(row.computed)
      : !row.supported && row.specified === "" && row.computed === "none");

    const probes: BrowserPaintProbe[] = [
      { id: "chromium.linear.magic-corner", source: "css_gradient_value.cc:1282-1337,1410-1430", expected: discriminators, actual: gradientActual, pass: gradientPass },
      { id: "chromium.clip.content-box", source: "geometry_box_utils.cc:13-49 and clip_path_clipper.cc:242-261", expected: clipSamples.map(({ x, y, expected }) => ({ x, y, expected })), actual: clipSamples, pass: clipPass },
      { id: "chromium.mask.repeat-phase", source: "CSSMaskPainter FillLayer tiling geometry", expected: maskSamples.map(({ x, expected }) => ({ x, expected })), actual: maskSamples, pass: maskPass },
      { id: "chromium.radial.negative-domain-shift", source: "css_gradient_value.cc:593-633,809-824", expected: radialSamples.map(({ radius, expected }) => ({ radius, expected })), actual: radialSamples, pass: radialPass },
      { id: "chromium.conic.center-angle-domain", source: "css_gradient_value.cc:2241-2270,656-824", expected: conicSamples.map(({ x, y, expected }) => ({ x, y, expected })), actual: conicSamples, pass: conicPass },
      { id: "chromium.clip.svg-reference-boxes", source: "svg_resources.cc:51-91 and clip_path_clipper.cc:367-386", expected: svgBoxSamples.map(({ x, y, expected }) => ({ x, y, expected })), actual: svgBoxSamples, pass: svgBoxPass },
      { id: "chromium.clip.url-html-border-origin", source: "clip_path_clipper.cc:364-400 and MaskToContentTransform", expected: htmlUrlSamples.map(({ x, y, expected }) => ({ x, y, expected })), actual: htmlUrlSamples, pass: htmlUrlPass },
      { id: "chromium.clip.url-svg-forced-fill-box", source: "clip_path_clipper.cc:368-374 and layout_svg_resource_clipper.cc:237-247", expected: svgUrlSamples.map(({ x, y, expected }) => ({ x, y, expected })), actual: svgUrlSamples, pass: svgUrlPass },
      { id: "chromium.clip.url-html-object-bbox", source: "clip_path_clipper.cc:364-400 and layout_svg_resource_clipper.cc:237-247", expected: htmlObjectUrlSamples.map(({ x, y, expected }) => ({ x, y, expected })), actual: htmlObjectUrlSamples, pass: htmlObjectUrlPass },
      { id: "chromium.clip.url-geometry-box-grammar", source: "longhands_custom.cc:2340-2366 and style_builder_converter.cc:363-398", expected: "bare URL valid; every URL+geometry-box ordering invalid", actual: urlSyntax, pass: urlSyntaxPass },
    ];
    return { sourceRevision: SOURCE_REVISION, chromiumVersion: browser.version(), playwrightVersion, platform: process.platform, architecture: process.arch, deviceScaleFactor: DPR, probes, verdict: probes.every((probe) => probe.pass) ? "browser-validates-source-rules" : "browser-source-drift" };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  const report = await runBrowserPaintOracle();
  const failures = report.probes.filter((probe) => !probe.pass);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(`paint geometry browser oracle: ${report.probes.length - failures.length}/${report.probes.length}; ${report.chromiumVersion}; source ${report.sourceRevision}`);
  for (const failure of failures) console.log(`FAIL ${failure.id}`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
