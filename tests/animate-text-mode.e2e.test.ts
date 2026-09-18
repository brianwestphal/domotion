import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimate } from "../src/cli/animate.js";
import { launchChromium, setRenderTextMode } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-FJZQ34: `domotion animate --text-mode <mode>` selects the text-emit
// strategy for every frame of an animated capture, mirroring the `capture` CLI
// (DM-2716). This drives `runAnimate` end-to-end over a two-frame config and
// inspects the composed multi-frame SVG. `system-font` mode is the interesting
// one: each frame's text must be authored `<text>` carrying the source family,
// with no embedded `@font-face` subset and no glyph `<path>` outlines — across
// ALL frames, not just the first.

async function canLaunch(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}

const browser = await canLaunch();
if (browser) await closeBrowserSafely(browser); // runAnimate owns its own browser; we only probe launchability.

const dir = mkdtempSync(join(tmpdir(), "domotion-animate-text-mode-"));
const style = `*{margin:0}body{background:#fff;color:#0d1117}` +
  `.a{padding:24px;font:600 26px/1.4 'Helvetica Neue',Arial,sans-serif;text-decoration:underline}`;
const frame1 = join(dir, "frame1.html");
const frame2 = join(dir, "frame2.html");
writeFileSync(frame1, `<!doctype html><meta charset="utf-8"><style>${style}</style><div class="a">FirstFrameText</div>`);
writeFileSync(frame2, `<!doctype html><meta charset="utf-8"><style>${style}</style><div class="a">SecondFrameText</div>`);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// runAnimate sets the render-text mode as a process-global and (like the
// one-shot CLI) never restores it; reset to the default after every case so a
// system-font run can't leak into a later test in this worker.
afterEach(() => {
  setRenderTextMode("embedded-font");
});

async function animate(args: string[]): Promise<string> {
  const cfgPath = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgPath, JSON.stringify({
    width: 480, height: 160,
    frames: [
      { input: frame1, duration: 400 },
      { input: frame2, duration: 400 },
    ],
  }));
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.svg`);
  await runAnimate([cfgPath, "--quiet", "-o", out, ...args], "");
  return readFileSync(out, "utf8");
}

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("animate --text-mode (DM-FJZQ34)", () => {
  it("rejects an out-of-enum --text-mode before launching a browser", async () => {
    const cfgPath = join(dir, "cfg-bad.json");
    writeFileSync(cfgPath, JSON.stringify({ width: 480, height: 160, frames: [{ input: frame1, duration: 400 }] }));
    await expect(runAnimate([cfgPath, "--text-mode", "bogus", "-o", join(dir, "x.svg")], ""))
      .rejects.toThrow(/--text-mode expects one of/);
  });

  it("system-font mode emits authored <text> per frame, no @font-face, no glyph <path>", async () => {
    const svg = await animate(["--text-mode", "system-font"]);
    // Authored, viewer-painted text — no embedded subset, no outlines.
    expect(svg).toContain("<text ");
    expect(svg).toMatch(/font-family="[^"]*Helvetica Neue/);
    expect(svg).not.toContain("@font-face");
    expect(svg).not.toContain("<path");
    // Both frames' text survives the multi-frame composition.
    expect(svg).toContain("FirstFrameText");
    expect(svg).toContain("SecondFrameText");
  }, 60_000);

  it("default (embedded-font) mode embeds a subset instead of authored <text>", async () => {
    const svg = await animate([]);
    // The fidelity default self-contains the fonts; proves --text-mode changed
    // behavior rather than being inert (both arms otherwise identical).
    expect(svg).toContain("@font-face");
  }, 60_000);
});
