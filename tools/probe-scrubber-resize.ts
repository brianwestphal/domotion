/** Controlled scrubber resize investigation: no production behavior changes. */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { release } from "node:os";
import type { ElementHandle, Page } from "@playwright/test";
import sharp from "sharp";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { launchChromium } from "../src/capture/index.js";
import { startScrubberServer } from "../src/scrubber/server.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
const options = parseArgs({
  options: { svg: { type: "string" }, output: { type: "string" }, arms: { type: "string" } },
}).values;
const allArms = [
  "animated-resize",
  "animated-no-resize",
  "static-resize",
  "animated-natural-size",
  "static-natural-size",
] as const;
type Arm = (typeof allArms)[number];
const arms = (options.arms?.split(",") ?? [...allArms]).map((value) => {
  const arm = allArms.find((candidate) => candidate === value);
  if (arm == null) throw new Error(`Unknown probe arm: ${value}`);
  return arm;
});
if (arms.length === 0 || new Set(arms).size !== arms.length) throw new Error("Choose distinct probe arms");
const sourcePath = resolve(options.svg ?? "examples/animate/overlay-window/overlay-window.svg");
const sourceBytes = readFileSync(sourcePath);
const source = sourceBytes.toString("utf8");
const out = resolve(options.output ?? "tests/output/scrubber-resize");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "source.svg"), sourceBytes);
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
async function readSnapshot(page: Page, originalSvg: ElementHandle<HTMLElement | SVGElement>) {
  const d = await evaluateInFrame(page, () => {
    const svg = document.querySelector<SVGSVGElement>("[data-svg-host] > svg")!;
    const host = svg.parentElement!;
    const stage = document.querySelector(".stage")!;
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const targets = [...svg.querySelectorAll("*")];
    return {
      at: performance.now(),
      viewport: { w: innerWidth, h: innerHeight },
      time: document.querySelector(".time")?.textContent,
      hostTransform: getComputedStyle(host).transform,
      stage: box(stage),
      host: box(host),
      svg: box(svg),
      svgMarkup: svg.outerHTML,
      svgLayout: {
        width: getComputedStyle(svg).width,
        height: getComputedStyle(svg).height,
        flexShrink: getComputedStyle(svg).flexShrink,
        viewBox: { width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height },
      },
      graphics: [...svg.querySelectorAll<SVGGraphicsElement>("rect,text")].map((element) => {
        const matrix = element.getScreenCTM();
        return {
          tag: element.tagName,
          text: element.textContent,
          box: box(element),
          screenMatrix:
            matrix == null ? null : { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f },
        };
      }),
      smilTime: svg.getCurrentTime(),
      smilPaused: svg.animationsPaused(),
      fontStatus: document.fonts.status,
      fontFaces: [...document.fonts].map((f) => ({ family: f.family, status: f.status, weight: f.weight })),
      animations: document
        .getAnimations()
        .filter((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return t != null && svg.contains(t);
        })
        .map((a) => {
          const e = a.effect as KeyframeEffect,
            t = e.target!,
            cs = getComputedStyle(t);
          return {
            name: (a as CSSAnimation).animationName,
            target: targets.indexOf(t),
            tag: t.tagName,
            id: t.id,
            class: t.getAttribute("class"),
            time: a.currentTime,
            state: a.playState,
            pending: a.pending,
            start: a.startTime,
            progress: e.getComputedTiming().progress,
            transform: cs.transform,
            opacity: cs.opacity,
            display: cs.display,
            visibility: cs.visibility,
            box: box(t),
          };
        }),
    };
  });
  const { svgMarkup, ...rest } = d;
  return {
    ...rest,
    svgMarkupSha256: hash(svgMarkup),
    originalSvgStillAttached: await originalSvg.evaluate(
      (element) => element.isConnected && element === document.querySelector("[data-svg-host] > svg"),
    ),
  };
}

type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
const browser = await launchChromium();
const report: Array<{
  arm: Arm;
  sourceSha256: string;
  states: Array<{ state: string; before: Snapshot; after: Snapshot; pngSha256: string }>;
  differences?: Awaited<ReturnType<typeof pixelDifferences>>;
}> = [];
try {
  for (const arm of arms) {
    const svg = arm.startsWith("static")
      ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect x="40" y="40" width="320" height="220" fill="steelblue"/><text x="70" y="100" fill="white">static geometry control</text></svg>'
      : source;
    const server = await startScrubberServer({
      initialSvg: svg,
      initialName: "overlay-window.svg",
      port: 0,
      launchBrowser: launchChromium,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.goto(server.url, { waitUntil: "networkidle" });
      await page.locator('[data-action="scrub"]:not([disabled])').waitFor();
      await page.locator('[data-action="scrub"]').evaluate((el) => {
        (el as HTMLInputElement).value = "500";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      if (arm.endsWith("natural-size"))
        await page.locator("[data-svg-host] > svg").evaluate((element) => {
          (element as SVGSVGElement).style.flexShrink = "0";
        });
      await page.waitForTimeout(300);
      const originalSvg = await page.locator("[data-svg-host] > svg").elementHandle();
      if (originalSvg == null) throw new Error("Loaded SVG is missing");
      const states: (typeof report)[number]["states"] = [];
      for (const [state, w, h] of [
        ["wide", 1440, 900],
        ["medium", 900, 900],
        ["narrow", 390, 844],
        ["wide-return", 1440, 900],
      ] as const) {
        await page.setViewportSize({
          width: arm.includes("no-resize") ? 1440 : w,
          height: arm.includes("no-resize") ? 900 : h,
        });
        await page.waitForTimeout(150);
        const before = await readSnapshot(page, originalSvg);
        const png = await page.screenshot({ path: resolve(out, `${arm}-${state}.png`), animations: "allow" });
        const after = await readSnapshot(page, originalSvg);
        states.push({ state, before, after, pngSha256: hash(png) });
      }
      report.push({
        arm,
        sourceSha256: hash(svg),
        states,
        differences: await pixelDifferences(arm, states[0]!.before.stage),
      });
      writeFileSync(
        resolve(out, "report.json"),
        JSON.stringify(
          {
            sourceSha256: hash(sourceBytes),
            sourceBytes: sourceBytes.length,
            runtime: {
              node: process.version,
              platform: process.platform,
              architecture: process.arch,
              osRelease: release(),
              browser: browser.version(),
            },
            probeSha256: hash(readFileSync(new URL(import.meta.url))),
            scrubberBundleSha256: hash(
              readFileSync(new URL("../src/scrubber/client.bundle.generated.ts", import.meta.url)),
            ),
            arms: report,
          },
          null,
          2,
        ),
      );
      await page.close();
    } finally {
      await server.close();
    }
  }
} finally {
  await closeBrowserSafely(browser);
}
if (hash(readFileSync(sourcePath)) !== hash(sourceBytes)) throw new Error("Source bytes changed during the probe");
console.log(
  JSON.stringify(
    report.map(({ arm, differences }) => ({ arm, differences })),
    null,
    2,
  ),
);

async function pixelDifferences(arm: Arm, stage: { x: number; y: number; w: number; h: number }) {
  const { data: before, info } = await sharp(resolve(out, `${arm}-wide.png`))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const after = await sharp(resolve(out, `${arm}-wide-return.png`))
    .raw()
    .toBuffer();
  if (before.length !== after.length) throw new Error("Roundtrip image dimensions changed");
  let total = 0,
    stagePixels = 0,
    maximumChannelDelta = 0;
  for (let at = 0; at < after.length; at += info.channels) {
    let changed = false;
    for (let channel = 0; channel < info.channels; channel++) {
      const delta = Math.abs(before[at + channel]! - after[at + channel]!);
      if (delta !== 0) {
        changed = true;
        maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      }
    }
    if (!changed) continue;
    total++;
    const pixel = at / info.channels,
      x = (pixel % info.width) + 0.5,
      y = Math.floor(pixel / info.width) + 0.5;
    if (x >= stage.x && x < stage.x + stage.w && y >= stage.y && y < stage.y + stage.h) stagePixels++;
  }
  return { totalPixels: total, stagePixels, footerPixels: total - stagePixels, maximumChannelDelta };
}
