/**
 * DM-1562 / DM-1563 (docs/94): `hoverReveal` sugar and `hoverDetect` auto-
 * detection — real-Chromium round-trips proving the SYNTHESIS reaches the
 * rendered SVG (the pure diff/classify + config-expansion logic is covered by
 * `hover-detect.test.ts` / `hover-reveal.test.ts`).
 *
 *   1. `hoverReveal` expands one field into a rest→forced-hover crossfade pair.
 *   2. `hoverDetect` on a pure-transform hover DETECTS a motion-only change and
 *      synthesizes an intra-frame scale tween (one frame, no crossfade).
 *   3. `hoverDetect` on a background/box-shadow hover DETECTS a paint change and
 *      synthesizes a rest→hover crossfade that carries the hover color.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { composeAnimateConfig, launchChromium, validateAnimateConfig } from "../index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

const REST = "rgb(35,134,54)"; // #238636
const HOVER = "rgb(46,160,67)"; // #2ea043

// A card whose button changes background (+ card border) on :hover — a PAINT hover.
const PAINT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  body{background:#0d1117;height:320px}
  .card{margin:40px;padding:24px;width:300px;background:#161b22;border:2px solid #30363d;border-radius:12px}
  .cta{display:block;width:100%;padding:12px;border:none;border-radius:8px;background:#238636;color:#fff;font-size:16px}
  .cta:hover{background:#2ea043}
</style></head><body>
  <div class="card"><button class="cta">Start free trial</button></div>
</body></html>`;

// A button that ONLY scales on :hover — a MOTION-only hover (no paint delta).
const MOTION_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  body{background:#0d1117;height:240px;display:flex;align-items:center;justify-content:center}
  .cta{padding:14px 30px;border:none;border-radius:10px;background:#6e40c9;color:#fff;font-size:16px;transform:none}
  .cta:hover{transform:scale(1.08)}
</style></head><body><button class="cta">Add</button></body></html>`;

async function canLaunch(): Promise<Browser | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await canLaunch();

const dir = mkdtempSync(join(tmpdir(), "domotion-hover-detect-"));
const paintPath = join(dir, "paint.html");
const motionPath = join(dir, "motion.html");
writeFileSync(paintPath, PAINT_PAGE);
writeFileSync(motionPath, MOTION_PAGE);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (browser) await closeBrowserSafely(browser);
});

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("hoverReveal / hoverDetect synthesis → rendered SVG (DM-1562 / DM-1563)", () => {
  it("hoverReveal expands one field into a rest→forced-hover crossfade pair", async () => {
    const cfg = validateAnimateConfig({
      width: 460, height: 320,
      frames: [{ input: paintPath, duration: 800, hoverReveal: { selector: ".cta" } }],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(2);
    const groups = svg.split(/(?=class="f f-\d+")/);
    const rest = groups.find((c) => /class="f f-0"/.test(c)) ?? "";
    const hover = groups.find((c) => /class="f f-1"/.test(c)) ?? "";
    expect(rest).toContain(REST);
    expect(hover).toContain(HOVER);
    expect(svg).toMatch(/@keyframes fv-0/); // crossfade compositing
  }, 120_000);

  it("hoverDetect on a motion-only hover synthesizes a single-frame scale tween (no crossfade)", async () => {
    const cfg = validateAnimateConfig({
      width: 420, height: 240,
      frames: [{ input: motionPath, duration: 1200, hoverDetect: { selector: ".cta" } }],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    // Motion mode → one frame, an intra-frame transform tween, no crossfade pair.
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(1);
    expect(svg).toMatch(/@keyframes f0-/);
    expect(svg).toMatch(/matrix\(1\.08/);
    expect(svg).toContain("rgb(110,64,201)"); // #6e40c9 — the untouched button color
  }, 120_000);

  it("hoverDetect on a paint hover synthesizes a rest→hover crossfade carrying the hover color", async () => {
    const cfg = validateAnimateConfig({
      width: 460, height: 320,
      frames: [{ input: paintPath, duration: 800, hoverDetect: { selector: ".cta" } }],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(2);
    const groups = svg.split(/(?=class="f f-\d+")/);
    const rest = groups.find((c) => /class="f f-0"/.test(c)) ?? "";
    const hover = groups.find((c) => /class="f f-1"/.test(c)) ?? "";
    expect(rest).toContain(REST);
    expect(rest).not.toContain(HOVER);
    expect(hover).toContain(HOVER);
    expect(svg).toMatch(/@keyframes fv-0/);
  }, 120_000);

  it("hoverDetect on a page with no hover change keeps a single rest frame", async () => {
    const flat = join(dir, "flat.html");
    writeFileSync(flat, `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#0d1117;height:200px}.cta{padding:10px;background:#333;color:#fff}</style></head><body><button class="cta">No hover</button></body></html>`);
    const cfg = validateAnimateConfig({
      width: 300, height: 200,
      frames: [{ input: flat, duration: 800, hoverDetect: { selector: ".cta" } }],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(1);
  }, 120_000);
});
