import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import { startScrubberServer } from "../src/scrubber/server.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { chooseKerfSelectOption } from "../src/test-support/kerf-select.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(() => closeBrowserSafely(browser));
const output = resolve(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "scrubber-natural-size");
mkdirSync(output, { recursive: true });
async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
async function geometry(page: Page) {
  return evaluateInFrame(page, () => {
    const svg = document.querySelector<SVGSVGElement>("[data-svg-host] > svg")!;
    const host = svg.parentElement!;
    const matrix = new DOMMatrix(getComputedStyle(host).transform);
    const bounds = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const crop = document.querySelector(".crop-box")!;
    return {
      stage: bounds(document.querySelector(".stage")!),
      stageLayout: {
        w: document.querySelector<HTMLElement>(".stage")!.clientWidth,
        h: document.querySelector<HTMLElement>(".stage")!.clientHeight,
      },
      svg: bounds(svg),
      layout: { w: parseFloat(getComputedStyle(svg).width), h: parseFloat(getComputedStyle(svg).height) },
      zoom: matrix.a,
      panX: matrix.e,
      panY: matrix.f,
      nestedFlex: (() => {
        const nested = svg.querySelector("[data-nested-flex-control]");
        return nested == null
          ? null
          : { width: parseFloat(getComputedStyle(nested).width), shrink: getComputedStyle(nested).flexShrink };
      })(),
      crop: getComputedStyle(crop.parentElement!).display === "none" ? null : bounds(crop),
    };
  });
}
function assertFrame(
  g: Awaited<ReturnType<typeof geometry>>,
  w: number,
  h: number,
  mode: "fit" | "fill" | "manual",
  panX = 0,
  panY = 0,
) {
  expect(g.layout).toEqual({ w, h });
  const z =
    mode === "manual"
      ? 2
      : mode === "fit"
        ? Math.min(g.stage.w / w, g.stage.h / h)
        : Math.max(g.stage.w / w, g.stage.h / h);
  // CSSOM matrices serialize finite decimal precision; layout uses 1/64px units.
  expect(g.zoom).toBeCloseTo(z, 4);
  expect(g.panX).toBe(panX);
  expect(g.panY).toBe(panY);
  expect(g.svg.w).toBeCloseTo(w * z, 1);
  expect(g.svg.h).toBeCloseTo(h * z, 1);
  expect(g.svg.x + g.svg.w / 2).toBeCloseTo(g.stage.x + g.stage.w / 2 + panX, 1);
  expect(g.svg.y + g.svg.h / 2).toBeCloseTo(g.stage.y + g.stage.h / 2 + panY, 1);
}
it.each([
  { shape: "landscape", w: 640, h: 360 },
  { shape: "square", w: 480, h: 480 },
  { shape: "portrait", w: 360, h: 640 },
])(
  "retains $shape natural sizing for Fit/Fill/manual zoom, pan and crop",
  async ({ shape, w, h }) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" style="flex-shrink:1"><rect width="${w}" height="${h}" fill="steelblue"/><foreignObject x="10" y="10" width="180" height="80"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;width:180px;height:80px"><svg xmlns="http://www.w3.org/2000/svg" data-nested-flex-control="" viewBox="0 0 300 60" style="min-width:0;width:300px;height:60px"><rect width="300" height="60" fill="orange"/></svg></div></foreignObject></svg>`;
    const server = await startScrubberServer({
      initialSvg: source,
      initialName: `${shape}.svg`,
      port: 0,
      launchBrowser: launchChromium,
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const records = [];
    try {
      await page.goto(server.url, { waitUntil: "networkidle" });
      await page.locator('[data-action="scrub"]:not([disabled])').waitFor();
      for (const mode of ["fit", "fill", "manual"] as const) {
        await chooseKerfSelectOption(page.locator("kui-select[name=zoompreset]"), mode === "manual" ? "2" : mode);
        for (const width of [1440, 390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await settle(page);
          const g = await geometry(page);
          records.push({ mode, width, ...g });
          writeFileSync(resolve(output, `${shape}.json`), JSON.stringify(records, null, 2));
          assertFrame(g, w, h, mode);
          expect(g.nestedFlex).toEqual({ width: 180, shrink: "1" });
        }
      }
      await page.locator(".stage").hover();
      await page.mouse.wheel(40, 20);
      await settle(page);
      await page.locator("button[data-action=croptoggle]").click();
      await settle(page);
      expect(await page.locator("button[data-action=croptoggle]").getAttribute("aria-pressed")).toBe("true");
      for (const width of [1440, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await settle(page);
        const g = await geometry(page);
        records.push({ mode: "manual-pan-crop", width, ...g });
        writeFileSync(resolve(output, `${shape}.json`), JSON.stringify(records, null, 2));
        assertFrame(g, w, h, "manual", -40, -20);
        expect(g.crop).not.toBeNull();
        // Crop already uses integer client dimensions; preserve that contract.
        expect(g.crop!.x).toBeCloseTo(g.stage.x + g.stageLayout.w / 2 - 40 - w, 1);
        expect(g.crop!.y).toBeCloseTo(g.stage.y + g.stageLayout.h / 2 - 20 - h, 1);
        expect(g.crop!.w).toBeCloseTo(w * 2, 1);
        expect(g.crop!.h).toBeCloseTo(h * 2, 1);
      }
    } finally {
      await page.close();
      await server.close();
    }
  },
  60_000,
);
it("preserves paused SVG/SMIL pose and source-stage pixels through the original resize round trip", async () => {
  const path = resolve("examples/animate/overlay-window/overlay-window.svg");
  const bytes = readFileSync(path),
    source = bytes.toString("utf8");
  const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
  const server = await startScrubberServer({
    initialSvg: source,
    initialName: "overlay-window.svg",
    port: 0,
    launchBrowser: launchChromium,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    await page.goto(server.url, { waitUntil: "networkidle" });
    await page.locator('[data-action="scrub"]:not([disabled])').waitFor();
    const original = await page.locator("[data-svg-host] > svg").elementHandle();
    expect(original).not.toBeNull();
    await page.locator('[data-action="scrub"]').evaluate((element) => {
      (element as HTMLInputElement).value = "500";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(page);
    const sample = () =>
      evaluateInFrame(page, () => {
        const svg = document.querySelector<SVGSVGElement>("[data-svg-host] > svg")!;
        const animations = document.getAnimations().filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return target != null && svg.contains(target);
        });
        return {
          markup: svg.outerHTML,
          time: document.querySelector(".time")!.textContent,
          smil: svg.getCurrentTime(),
          smilPaused: svg.animationsPaused(),
          animations: animations.map((a) => ({ time: a.currentTime, state: a.playState })),
          textBoxes: [...svg.querySelectorAll("text")].map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }),
        };
      });
    const states = [];
    const images: Buffer[] = [];
    for (const [state, width, height] of [
      ["wide", 1440, 900],
      ["medium", 900, 900],
      ["narrow", 390, 844],
      ["wide-return", 1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await settle(page);
      const before = await sample(),
        g = await geometry(page);
      const image = await page.screenshot({ path: resolve(output, `${state}.png`), animations: "allow" });
      const after = await sample();
      images.push(image);
      states.push({ state, geometry: g, before, after });
    }
    writeFileSync(
      resolve(output, "paused-roundtrip.json"),
      JSON.stringify({ sourceSha256: hash(bytes), states }, null, 2),
    );
    for (const s of states) {
      assertFrame(s.geometry, 640, 360, "fit");
      expect(s.before).toEqual(s.after);
      expect(s.before.time).toBe("0:02.50 / 0:05.00");
      expect(s.before.smil).toBe(2.5);
      expect(s.before.smilPaused).toBe(true);
      expect(s.before.animations).toHaveLength(16);
      expect(s.before.animations.every((a) => a.state === "paused" && a.time === 2500)).toBe(true);
    }
    expect(
      await original!.evaluate((el) => el.isConnected && el === document.querySelector("[data-svg-host] > svg")),
    ).toBe(true);
    expect(states[0]!.before).toEqual(states[3]!.before);
    const clip = { left: 0, top: 0, width: 1440, height: Math.floor(states[0]!.geometry.stage.h) };
    expect(await sharp(images[0]!).extract(clip).raw().toBuffer()).toEqual(
      await sharp(images[3]!).extract(clip).raw().toBuffer(),
    );
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    await page.close();
    await server.close();
  }
}, 60_000);
