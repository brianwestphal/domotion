#!/usr/bin/env tsx
/** DM-2514 live Chromium side oracle. Logical coordinates are gated by
 * `vertical-decoration-oracle.ts`; this lane only authenticates the discrete
 * left/right consequences in native paint at coherent DPR 1 and 4. Coverage
 * centroids are reported as raster-phase observations and never feed a source
 * constant or tolerance. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";

type Side = "left" | "right";

interface Probe {
  id: string;
  writingMode: string;
  orientation: string;
  lang: string;
  position: string;
  text: string;
  zoom: number;
  expectedSide: Side;
}

export interface VerticalDecorationBrowserRow {
  id: string;
  deviceScaleFactor: number;
  expectedSide: Side;
  actualSide: Side;
  redPixelCount: number;
  rasterCentroidX: number;
  elementCenterX: number;
  pass: boolean;
}

export interface VerticalDecorationBrowserReport {
  chromiumVersion: string;
  deviceScaleFactors: [1, 4];
  rows: VerticalDecorationBrowserRow[];
  rasterPhase: "native-coverage-observation";
  acceptanceRole: "categorical-source-authentication-only";
  verdict: "browser-authenticates-source-sides" | "browser-side-authentication-failed";
}

const PROBES: Probe[] = [
  { id: "central-en-auto", writingMode: "vertical-rl", orientation: "mixed", lang: "en", position: "auto", text: "A", zoom: 1, expectedSide: "left" },
  { id: "central-ja-auto", writingMode: "vertical-rl", orientation: "mixed", lang: "ja", position: "auto", text: "A", zoom: 1, expectedSide: "right" },
  { id: "central-ja-left", writingMode: "vertical-lr", orientation: "upright", lang: "ja", position: "under left", text: "日", zoom: 1, expectedSide: "left" },
  { id: "central-en-right", writingMode: "vertical-lr", orientation: "mixed", lang: "en", position: "from-font right", text: "日", zoom: 1, expectedSide: "right" },
  { id: "sideways-rl-auto", writingMode: "sideways-rl", orientation: "mixed", lang: "ja", position: "right", text: "A", zoom: 1, expectedSide: "left" },
  { id: "sideways-lr-under", writingMode: "sideways-lr", orientation: "mixed", lang: "en", position: "under", text: "A", zoom: 1, expectedSide: "right" },
  { id: "vertical-sideways", writingMode: "vertical-rl", orientation: "sideways", lang: "ja", position: "right", text: "A", zoom: 1, expectedSide: "left" },
  { id: "zoom-125-ja-auto", writingMode: "vertical-rl", orientation: "upright", lang: "ja", position: "auto", text: "A", zoom: 1.25, expectedSide: "right" },
];

function html(fontData: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:DM2514Live;src:url(data:font/ttf;base64,${fontData}) format("truetype")}
    html,body{margin:0;width:1500px;height:260px;background:#fff;overflow:hidden}
    .probe{position:absolute;top:35px;height:150px;font-family:DM2514Live,sans-serif;
      font-size:32px;line-height:1.2;color:transparent;display:inline-block;
      text-decoration-line:underline;text-decoration-style:solid;
      text-decoration-thickness:4px;text-underline-offset:3px;
      text-decoration-color:rgb(255,0,0);text-decoration-skip-ink:none}
  </style>${PROBES.map((p, i) => `<span id="${p.id}" class="probe" lang="${p.lang}"
    style="left:${45 + i * 130}px;writing-mode:${p.writingMode};text-orientation:${p.orientation};
      text-underline-position:${p.position};zoom:${p.zoom}">${p.text}</span>`).join("")}`;
}

export async function runVerticalDecorationBrowserOracle(): Promise<VerticalDecorationBrowserReport> {
  const browser = await chromium.launch();
  const rows: VerticalDecorationBrowserRow[] = [];
  try {
    for (const deviceScaleFactor of [1, 4] as const) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 260 }, deviceScaleFactor });
      const page = await context.newPage();
      try {
        await page.setContent(html(readFileSync("assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf").toString("base64")), { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        const rects = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
          const rect = document.getElementById(id)!.getBoundingClientRect();
          return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
        })), PROBES.map((probe) => probe.id));
        const png = await page.screenshot();
        const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixels = decoded.data;
        const stride = decoded.info.width * 4;
        for (const probe of PROBES) {
          const rect = rects[probe.id] as { x: number; y: number; width: number; height: number };
          const minX = Math.max(0, Math.floor((rect.x - 30) * deviceScaleFactor));
          const maxX = Math.min(decoded.info.width - 1, Math.ceil((rect.x + rect.width + 30) * deviceScaleFactor));
          const minY = Math.max(0, Math.floor((rect.y - 4) * deviceScaleFactor));
          const maxY = Math.min(decoded.info.height - 1, Math.ceil((rect.y + rect.height + 4) * deviceScaleFactor));
          let count = 0;
          let sumX = 0;
          for (let py = minY; py <= maxY; py++) {
            for (let px = minX; px <= maxX; px++) {
              const at = py * stride + px * 4;
              const red = pixels[at];
              const green = pixels[at + 1];
              const blue = pixels[at + 2];
              if (red > 160 && red > green * 1.8 && red > blue * 1.8) {
                count++;
                sumX += (px + 0.5) / deviceScaleFactor;
              }
            }
          }
          const rasterCentroidX = count > 0 ? sumX / count : Number.NaN;
          const elementCenterX = rect.x + rect.width / 2;
          const actualSide: Side = rasterCentroidX < elementCenterX ? "left" : "right";
          rows.push({
            id: probe.id,
            deviceScaleFactor,
            expectedSide: probe.expectedSide,
            actualSide,
            redPixelCount: count,
            rasterCentroidX,
            elementCenterX,
            pass: count > 0 && actualSide === probe.expectedSide,
          });
        }
      } finally {
        await context.close();
      }
    }
    const pass = rows.length === PROBES.length * 2 && rows.every((row) => row.pass);
    return {
      chromiumVersion: browser.version(),
      deviceScaleFactors: [1, 4],
      rows,
      rasterPhase: "native-coverage-observation",
      acceptanceRole: "categorical-source-authentication-only",
      verdict: pass ? "browser-authenticates-source-sides" : "browser-side-authentication-failed",
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const report = await runVerticalDecorationBrowserOracle();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "browser-authenticates-source-sides") process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
