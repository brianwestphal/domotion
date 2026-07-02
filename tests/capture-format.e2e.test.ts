import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "../src/cli/capture.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1538: `domotion capture --format <name|WxH>` sizes the capture VIEWPORT via
// the shared format machinery, with explicit --width/--height still winning, and
// `--safe-guide` overlays the resolved safe-area rectangle (informational — no
// reflow). This drives `runCapture` end-to-end against a local HTML file and
// inspects the produced SVG (skips where Chromium can't launch, like the other
// browser-driven e2e tests).

async function canLaunch(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}

const browser = await canLaunch();
const dir = mkdtempSync(join(tmpdir(), "domotion-capture-format-"));
const htmlPath = join(dir, "page.html");
writeFileSync(
  htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}body{background:#0ea5e9;height:2400px}</style></head><body></body></html>`,
);

afterAll(async () => {
  await closeBrowserSafely(browser ?? undefined);
  rmSync(dir, { recursive: true, force: true });
}, 15_000);

const describeBrowser = browser ? describe : describe.skip;

async function capture(args: string[]): Promise<string> {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.svg`);
  await runCapture([htmlPath, "--quiet", "-o", out, ...args], "");
  return readFileSync(out, "utf8");
}

describeBrowser("capture --format viewport sizing (DM-1538)", () => {
  it("a preset sizes the capture viewport (reel → 1080×1920)", async () => {
    const svg = await capture(["--format", "reel"]);
    expect(svg).toMatch(/width="1080" height="1920"/);
  }, 60_000);

  it("a raw WxH format sizes the viewport", async () => {
    const svg = await capture(["--format", "900x1600"]);
    expect(svg).toMatch(/width="900" height="1600"/);
  }, 60_000);

  it("explicit --width wins over the format on that axis (format supplies the other)", async () => {
    const svg = await capture(["--format", "reel", "--width", "800"]);
    expect(svg).toMatch(/width="800" height="1920"/);
  }, 60_000);

  it("--safe-guide overlays the resolved safe-area rectangle at the format's inset", async () => {
    const svg = await capture(["--format", "reel", "--safe-guide"]);
    expect(svg).toContain('data-domotion-safe-guide="1"');
    // reel inset {230,65,346,65} → rect at (65,230) sized 950×1344.
    expect(svg).toContain('x="65"');
    expect(svg).toContain('width="950"');
  }, 60_000);

  it("--safe-guide without --format is rejected at the CLI boundary", async () => {
    await expect(runCapture([htmlPath, "--quiet", "--safe-guide", "-o", join(dir, "x.svg")], "")).rejects.toThrow(
      /--safe-guide requires --format/,
    );
  }, 60_000);

  it("--format sizes the captured CONTENT; --chrome adds the bezel around it", async () => {
    const svg = await capture(["--format", "reel", "--chrome", "phone"]);
    // Phone bezel adds a 14px rim per side → 1080+28 × 1920+28.
    expect(svg).toMatch(/width="1108" height="1948"/);
  }, 60_000);
});
