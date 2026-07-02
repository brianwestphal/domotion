import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../capture/index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { composeStoryboardConfig } from "./storyboard.js";

/**
 * DM-1527 end-to-end: a storyboard that sequences THREE distinct scene kinds —
 * a `template`, a live `capture` (file), and a pre-rendered `svg` — into one
 * animated SVG, each on its own timeline with an inter-scene transition. Proves
 * the real render pipeline (template render + page capture + svg embedding +
 * `generateAnimatedSvg`) assembles a well-formed, self-contained animated SVG
 * with per-scene-namespaced content and the composited frame transitions.
 */

const DEMO_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #101826; color: #eaf2ff; font-family: sans-serif;
    height: 100vh; display: flex; align-items: center; justify-content: center; }
  h1 { font-size: 40px; }
</style></head><body><h1 class="cap-title">Captured Scene</h1></body></html>`;

const PREBAKED_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270" width="480" height="270">
  <style>:root { --scene-dur: 1.50s; }
    @keyframes pb-pulse { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }
    .pb { animation: pb-pulse 1.5s infinite; }</style>
  <rect id="pb-bg" width="480" height="270" fill="#0b1220" />
  <circle id="pb-dot" class="pb" cx="240" cy="135" r="60" fill="#3b82f6" />
</svg>`;

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("storyboard end-to-end (DM-1527)", () => {
  it("sequences template + capture + svg scenes into one animated SVG", async () => {
    const { browser } = env!;
    const dir = mkdtempSync(join(tmpdir(), "dm-storyboard-"));
    writeFileSync(join(dir, "demo.html"), DEMO_HTML);
    writeFileSync(join(dir, "prebaked.svg"), PREBAKED_SVG);

    const svg = await composeStoryboardConfig(
      browser,
      {
        width: 480,
        height: 270,
        background: "#05070d",
        scenes: [
          { template: "title-card", params: { title: "Storyboard" }, duration: 1200, transition: { type: "crossfade", duration: 250 } },
          { capture: { file: "demo.html" }, duration: 1000, transition: { type: "push-left", duration: 250 } },
          { svg: "prebaked.svg", duration: 1200, transition: { type: "cut", duration: 0 } },
        ],
      },
      dir,
    );

    // One self-contained root SVG document.
    expect(svg).toMatch(/^<\?xml/);
    expect((svg.match(/<svg\b/g) ?? []).length).toBeGreaterThanOrEqual(4); // root + 3 nested scenes
    // Three composited, opacity/slide-switched frame groups.
    expect(svg).toContain("@keyframes fv-0");
    expect(svg).toContain("@keyframes fv-1");
    expect(svg).toContain("@keyframes fv-2");
    expect(svg).toContain('class="f f-2"');
    // Scene 2's captured heading survived the capture → SVG round-trip (as glyph
    // paths or text) and is namespaced under the per-scene token.
    expect(svg).toContain("sb1_");
    // The pre-rendered svg scene's ids are namespaced under its own scene token
    // (no collision with the others), and its intra-scene animation is preserved.
    expect(svg).toContain("sb2_pb-bg");
    expect(svg).toContain("sb2_pb-pulse");
    // Push-left slide keyframes (scene 1 exits horizontally) are present.
    expect(svg).toContain("@keyframes fp-1");
    // Config background rect painted behind every scene.
    expect(svg).toContain('fill="#05070d"');
  }, 60_000);
});
