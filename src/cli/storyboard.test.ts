import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  composeStoryboardConfig,
  storyboardConfigSchema,
  validateStoryboardConfig,
} from "./storyboard.js";

/** A minimal self-contained animated SVG carrying a `--scene-dur` (so its play
 *  length is auto-detected) and one uniquely-named id + keyframe. */
function animatedSceneSvg(color: string, id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <style>:root { --scene-dur: 2.00s; }
    @keyframes ${id}-pulse { 0% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; } }
    .${id} { animation: ${id}-pulse 2s infinite; }</style>
  <rect id="${id}-rect" class="${id}" width="200" height="100" fill="${color}" />
</svg>`;
}

/** A static SVG (no animation → no intrinsic play time). */
function staticSceneSvg(color: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect width="200" height="100" fill="${color}" />
</svg>`;
}

/** The svg-source path never dereferences the browser, so an all-`svg` config
 *  composes with no real browser. */
const NO_BROWSER = null as unknown as Browser;

describe("storyboard config validation", () => {
  it("accepts a minimal valid config", () => {
    const cfg = validateStoryboardConfig({
      width: 200,
      height: 100,
      scenes: [{ svg: "a.svg", duration: 1000 }],
    });
    expect(cfg.scenes).toHaveLength(1);
  });

  it("rejects a scene with no source", () => {
    expect(() => validateStoryboardConfig({ width: 200, height: 100, scenes: [{ duration: 500 }] })).toThrow(/exactly one source/);
  });

  it("rejects a scene with two sources", () => {
    expect(() =>
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ svg: "a.svg", template: "cta", duration: 500 }] }),
    ).toThrow(/exactly one source/);
  });

  it("rejects `params` without a `template`", () => {
    expect(() =>
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ svg: "a.svg", params: { x: 1 }, duration: 500 }] }),
    ).toThrow(/params/);
  });

  it("rejects `term` without a `cast`", () => {
    expect(() =>
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ svg: "a.svg", term: { theme: "dark" }, duration: 500 }] }),
    ).toThrow(/term/);
  });

  it("rejects `period` without an `svg`", () => {
    expect(() =>
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ template: "cta", period: 1000 }] }),
    ).toThrow(/period/);
  });

  it("rejects a `capture` scene without url or file", () => {
    expect(() =>
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ capture: {}, duration: 500 }] }),
    ).toThrow(/exactly one of `url` or `file`/);
  });

  it("rejects a `capture` scene with both url and file", () => {
    expect(() =>
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ capture: { url: "http://x", file: "y.html" }, duration: 500 }] }),
    ).toThrow(/exactly one of `url` or `file`/);
  });

  it("only exposes the opaque-scene-safe transition set (no magic-move)", () => {
    // magic-move needs an element-tree bridge; distinct opaque scenes can't share one.
    const parsed = storyboardConfigSchema.safeParse({
      width: 10, height: 10,
      scenes: [{ svg: "a.svg", duration: 1, transition: { type: "magic-move", duration: 0 } }],
    });
    expect(parsed.success).toBe(false);
    // the four supported types validate.
    for (const type of ["crossfade", "cut", "push-left", "scroll"]) {
      const ok = storyboardConfigSchema.safeParse({
        width: 10, height: 10,
        scenes: [{ svg: "a.svg", duration: 1, transition: { type, duration: 0 } }],
      });
      expect(ok.success, `transition ${type} should validate`).toBe(true);
    }
  });
});

describe("storyboard composition (svg scenes, no browser)", () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "domotion-storyboard-"));
  }

  it("sequences two animated svg scenes into one animated SVG with namespaced content + transition keyframes", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "a.svg"), animatedSceneSvg("#f00", "aa"));
    writeFileSync(join(dir, "b.svg"), animatedSceneSvg("#00f", "bb"));
    const svg = await composeStoryboardConfig(
      NO_BROWSER,
      validateStoryboardConfig({
        width: 200,
        height: 100,
        background: "#101010",
        title: "T",
        desc: "D",
        scenes: [
          { svg: "a.svg", duration: 1500, transition: { type: "crossfade", duration: 300 } },
          { svg: "b.svg", duration: 1500 },
        ],
      }),
      dir,
    );
    // Both scenes are present and per-scene namespaced (no id collision).
    expect(svg).toContain("sb0_aa-rect");
    expect(svg).toContain("sb1_bb-rect");
    // The scene-level pulse @keyframes are namespaced too, so they can't collide.
    expect(svg).toContain("sb0_aa-pulse");
    expect(svg).toContain("sb1_bb-pulse");
    // Two composited frame groups with the animator's opacity keyframes.
    expect(svg).toContain("@keyframes fv-0");
    expect(svg).toContain("@keyframes fv-1");
    // Config-level background + a11y are applied by generateAnimatedSvg.
    expect(svg).toContain('fill="#101010"');
    expect(svg).toContain("<title>T</title>");
    expect(svg).toContain("<desc>D</desc>");
  });

  it("inherits an animated scene's play time when `duration` is omitted", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "a.svg"), animatedSceneSvg("#0f0", "cc")); // --scene-dur: 2s
    let logged = "";
    const svg = await composeStoryboardConfig(
      NO_BROWSER,
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ svg: "a.svg" }] }),
      dir,
      (m) => { logged += m + "\n"; },
    );
    expect(svg).toContain("sb0_cc-rect");
    expect(logged).toMatch(/defaulted to the scene's play time: 2000ms/);
  });

  it("errors when a static scene omits its required `duration`", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "s.svg"), staticSceneSvg("#333"));
    await expect(
      composeStoryboardConfig(
        NO_BROWSER,
        validateStoryboardConfig({ width: 200, height: 100, scenes: [{ svg: "s.svg" }] }),
        dir,
      ),
    ).rejects.toThrow(/no intrinsic play time/);
  });

  it("respects an explicit `period` override for an svg scene", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "s.svg"), staticSceneSvg("#333"));
    let logged = "";
    // A static SVG has no detectable period, but an explicit `period` makes it an
    // animated scene whose play time can be inherited.
    await composeStoryboardConfig(
      NO_BROWSER,
      validateStoryboardConfig({ width: 200, height: 100, scenes: [{ svg: "s.svg", period: 1234 }] }),
      dir,
      (m) => { logged += m + "\n"; },
    );
    expect(logged).toMatch(/defaulted to the scene's play time: 1234ms/);
  });
});
