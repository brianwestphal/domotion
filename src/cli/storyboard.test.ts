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

/** A base64 payload marker unique enough to count occurrences of the embedded
 *  font in the assembled output. base64 excludes `{`/`}`, so it's a valid
 *  `@font-face` body for `dedupeCompositeFonts`. */
const FONT_PAYLOAD = "AAEAAAALAIAAAwAwT1MvMg8SBfsAAAD8AAAAYGNtYXAaVcx1QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph";

/** An svg scene carrying a `dmf0` `@font-face` (same byte-identical payload every
 *  call) plus a `<text>` that uses it — so two of these embed the SAME font. */
function fontSceneSvg(id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <style>@font-face { font-family: "dmf0"; src: url("data:font/ttf;base64,${FONT_PAYLOAD}") format("truetype"); }
  :root { --scene-dur: 1.00s; }</style>
  <text id="${id}-t" x="10" y="50" font-family="dmf0" font-size="20">Hi</text>
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

  it("exposes the full cross-engine-safe transition set incl. the DM-1524 reveals (no magic-move)", () => {
    // magic-move needs an element-tree bridge; distinct opaque scenes can't share one.
    const parsed = storyboardConfigSchema.safeParse({
      width: 10, height: 10,
      scenes: [{ svg: "a.svg", duration: 1, transition: { type: "magic-move", duration: 0 } }],
    });
    expect(parsed.success).toBe(false);
    // DM-1552: the originals PLUS the DM-1524 expansion (directional pushes,
    // clip-path reveals, scale dollies, shine) all validate — plumbed straight
    // through to the animator's frame-transition enum.
    for (const type of [
      "crossfade", "cut", "push-left", "scroll",
      "push-right", "push-up", "push-down",
      "wipe", "iris", "zoom-in", "zoom-out", "shine",
    ]) {
      const ok = storyboardConfigSchema.safeParse({
        width: 10, height: 10,
        scenes: [{ svg: "a.svg", duration: 1, transition: { type, duration: 0 } }],
      });
      expect(ok.success, `transition ${type} should validate`).toBe(true);
    }
  });

  it("accepts per-scene overlays and a storyboard-level cursor track (DM-1554)", () => {
    const cfg = validateStoryboardConfig({
      width: 200, height: 100,
      cursor: { events: [{ frame: 0, at: 100, type: "moveClick", to: { x: 40, y: 40 } }] },
      scenes: [{ svg: "a.svg", duration: 1000, overlays: [{ kind: "typing", text: "hi", x: 10, y: 20 }] }],
    });
    expect(cfg.scenes[0].overlays).toHaveLength(1);
    expect(cfg.cursor?.events).toHaveLength(1);
  });

  it("rejects a cursor event that uses a `selector` (a scene retains no live DOM) (DM-1554)", () => {
    expect(() =>
      validateStoryboardConfig({
        width: 200, height: 100,
        cursor: { events: [{ frame: 0, type: "move", selector: ".btn" }] },
        scenes: [{ svg: "a.svg", duration: 1000 }],
      }),
    ).toThrow(/selector.*can't resolve|can't resolve.*selector|to.*coordinates/i);
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

  it("collapses a byte-identical embedded font shared across scenes to one copy (DM-1553)", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "a.svg"), fontSceneSvg("fa"));
    writeFileSync(join(dir, "b.svg"), fontSceneSvg("fb"));
    const svg = await composeStoryboardConfig(
      NO_BROWSER,
      validateStoryboardConfig({
        width: 200, height: 100,
        scenes: [
          { svg: "a.svg", duration: 1000, transition: { type: "crossfade", duration: 200 } },
          { svg: "b.svg", duration: 1000 },
        ],
      }),
      dir,
    );
    // Both scenes rendered (namespaced text nodes present, per scene).
    expect(svg).toContain("sb0_fa-t");
    expect(svg).toContain("sb1_fb-t");
    // Cross-scene font dedup: exactly ONE `@font-face` and ONE copy of the (heavy)
    // base64 payload survive, though each scene embedded its own.
    expect((svg.match(/@font-face/g) ?? []).length).toBe(1);
    expect((svg.match(new RegExp(FONT_PAYLOAD, "g")) ?? []).length).toBe(1);
    // The surviving copy is smaller than the two-payload total would be.
    const bothPayloads = FONT_PAYLOAD.length * 2;
    const onePayload = FONT_PAYLOAD.length;
    expect(svg.length).toBeLessThan(
      // a rough upper bound proving the second payload is gone
      svg.length + bothPayloads - onePayload,
    );
    // Both text nodes reference the single surviving family (sb1's was repointed).
    const famRefs = svg.match(/font-family="sb\d+_dmf0"/g) ?? [];
    expect(new Set(famRefs).size).toBe(1);
  });

  it("renders a per-scene typing overlay on top of the scene (DM-1554)", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "a.svg"), animatedSceneSvg("#123", "ov"));
    const svg = await composeStoryboardConfig(
      NO_BROWSER,
      validateStoryboardConfig({
        width: 200, height: 100,
        scenes: [{ svg: "a.svg", duration: 2000, overlays: [{ kind: "typing", text: "hello", x: 12, y: 40, caret: true }] }],
      }),
      dir,
    );
    // The typing overlay reveals its text over the scene (rendered as glyph paths
    // or text) — the animator's typing-overlay group + caret land in the output.
    expect(svg).toContain("sb0_ov-rect"); // the scene
    expect(svg).toContain('class="t0-caret"'); // typing caret group (frame 0)
    expect(svg).toMatch(/@keyframes t0-caret-pos/); // per-keystroke caret stepping
  });

  it("spans a cursor track across scenes (DM-1554)", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "a.svg"), animatedSceneSvg("#0a0", "sa"));
    writeFileSync(join(dir, "b.svg"), animatedSceneSvg("#00a", "sb"));
    const svg = await composeStoryboardConfig(
      NO_BROWSER,
      validateStoryboardConfig({
        width: 200, height: 100,
        cursor: {
          style: { scale: 1.2 },
          events: [
            { frame: 0, at: 200, type: "moveClick", to: { x: 40, y: 40 } },
            { frame: 1, at: 200, type: "moveClick", to: { x: 160, y: 60 } },
          ],
        },
        scenes: [
          { svg: "a.svg", duration: 1500, transition: { type: "crossfade", duration: 200 } },
          { svg: "b.svg", duration: 1500 },
        ],
      }),
      dir,
    );
    // The macOS-style cursor overlay is emitted once, spanning the whole loop.
    expect((svg.match(/class="cursor-overlay"/g) ?? []).length).toBe(1);
    // Two click pulses (one per scene) ride the single overlay.
    expect(svg).toContain("cursor-click-0");
    expect(svg).toContain("cursor-click-1");
  });

  it("rejects a cursor event referencing a scene index out of range (DM-1554)", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "a.svg"), animatedSceneSvg("#111", "oo"));
    await expect(
      composeStoryboardConfig(
        NO_BROWSER,
        validateStoryboardConfig({
          width: 200, height: 100,
          cursor: { events: [{ frame: 3, at: 0, type: "moveClick", to: { x: 10, y: 10 } }] },
          scenes: [{ svg: "a.svg", duration: 1000 }],
        }),
        dir,
      ),
    ).rejects.toThrow(/references scene 3, but there are only 1 scenes/);
  });
});
