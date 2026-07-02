import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimate } from "../src/cli/animate.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1538: `domotion animate --format <name|WxH>` re-targets the config's canvas
// (the animate viewport), with explicit --width/--height still winning over the
// format, which in turn wins over the config's own width/height. This drives
// `runAnimate` end-to-end and inspects the produced SVG's outer dimensions.

async function canLaunch(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}

const browser = await canLaunch();
if (browser) await closeBrowserSafely(browser); // runAnimate owns its own browser; we only probe launchability.

const dir = mkdtempSync(join(tmpdir(), "domotion-animate-format-"));
const htmlPath = join(dir, "page.html");
writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}body{background:#111;height:600px}</style></head><body></body></html>`);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const describeBrowser = browser ? describe : describe.skip;

async function animate(args: string[]): Promise<string> {
  const cfgPath = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgPath, JSON.stringify({ width: 640, height: 480, frames: [{ input: htmlPath, duration: 400 }] }));
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.svg`);
  await runAnimate([cfgPath, "--quiet", "-o", out, ...args], "");
  return readFileSync(out, "utf8");
}

describeBrowser("animate --format viewport sizing (DM-1538)", () => {
  it("uses the config's own width/height when no format flag is given", async () => {
    const svg = await animate([]);
    expect(svg).toMatch(/width="640" height="480"/);
  }, 60_000);

  it("a preset overrides the config canvas (reel → 1080×1920)", async () => {
    const svg = await animate(["--format", "reel"]);
    expect(svg).toMatch(/width="1080" height="1920"/);
  }, 60_000);

  it("explicit --width/--height win over the format", async () => {
    const svg = await animate(["--format", "reel", "--width", "720", "--height", "1280"]);
    expect(svg).toMatch(/width="720" height="1280"/);
  }, 60_000);
});
