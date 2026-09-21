import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { captureElementTree, elementTreeToSvg } from "../src/index.js";
import { runCapture } from "../src/cli/capture.js";
import { comparePngs } from "../src/review/compare-pngs.js";
import { clearEmbeddedFonts, clearGlyphDefs, withRenderTextMode } from "../src/render/index.js";

const WIDTH = 640;
const HEIGHT = 260;
const tempRoot = mkdtempSync(join(tmpdir(), "domotion-real-text-"));
let browser: Browser;
let sourcePage: Page;
let outputPage: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  sourcePage = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  outputPage = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
});

afterAll(async () => {
  await browser.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function render(tree: Awaited<ReturnType<typeof captureElementTree>>, realTextLayer?: boolean): string {
  clearGlyphDefs();
  clearEmbeddedFonts();
  return withRenderTextMode("paths", () =>
    elementTreeToSvg(tree, WIDTH, HEIGHT, realTextLayer == null ? undefined : { realTextLayer }),
  );
}

describe("inline SVG real-text layer (DM-1775)", () => {
  it("adds searchable/selectable AX text while producing zero visual regions", async () => {
    await sourcePage.setContent(`<!doctype html><style>
      html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#f7f3e8;color:#172554}
      main{padding:24px;font:20px/1.45 Arial,sans-serif}
      h1{margin:0 0 12px;font-size:34px;text-transform:uppercase}
      p{margin:0;width:560px}
      .tilt{display:inline-block;transform:rotate(-2deg);transform-origin:left center;color:#9f1239}
      input{display:block;margin-top:20px;width:300px;font:18px Arial,sans-serif}
    </style><main><h1>Searchable source title</h1><p>Authored lead <strong>mixed flow</strong> authored tail. <span class="tilt">Transformed words.</span></p><input value="copyable input value" aria-label="Example value"></main>`);
    const tree = await captureElementTree(sourcePage, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const ordinary = render(tree);
    expect(render(tree, false)).toBe(ordinary);
    const searchable = render(tree, true);

    expect(ordinary).not.toContain("data-domotion-real-text-layer");
    expect(searchable).toContain('data-domotion-real-text-layer="true"');
    expect(searchable).toContain('aria-hidden="true"');
    expect(searchable).not.toMatch(/aria-label="SEARCHABLE SOURCE TITLE"/);

    const ordinaryPath = join(tempRoot, "ordinary.png");
    const searchablePath = join(tempRoot, "searchable.png");
    const diffPath = join(tempRoot, "diff.png");
    await outputPage.setContent(`<body style="margin:0">${ordinary}</body>`);
    await outputPage.screenshot({ path: ordinaryPath });
    expect(await outputPage.evaluate(() => window.find("Searchable source title"))).toBe(false);
    await outputPage.setContent(`<body style="margin:0">${searchable}</body>`);
    await outputPage.screenshot({ path: searchablePath });
    const comparison = await comparePngs(outputPage, ordinaryPath, searchablePath, diffPath);
    expect(comparison.regionCount).toBe(0);
    expect(comparison.strictRegionCount).toBe(0);
    expect(comparison.nonAaPixels).toBe(0);

    expect(await outputPage.evaluate(() => window.find("Searchable source title"))).toBe(true);
    const copied = await outputPage.evaluate(() => {
      const runs = [...document.querySelectorAll("[data-domotion-real-text-run]")];
      const first = runs[0]?.firstChild;
      const last = runs.at(-1)?.lastChild;
      if (first == null || last == null) return "";
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent?.length ?? 0);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? "";
    });
    expect(copied).toContain("Searchable source title");
    expect(copied).toContain("Authored lead");
    expect(copied).toContain("mixed flow");
    expect(copied).toContain("authored tail");
    expect(copied).toContain("copyable input value");

    const client = await outputPage.context().newCDPSession(outputPage);
    const ax = await client.send("Accessibility.getFullAXTree");
    await client.detach();
    const nodes = ax.nodes.map((node) => ({ role: node.role?.value, name: node.name?.value }));
    expect(nodes.some((node) => node.role === "StaticText" && node.name === "Searchable source title")).toBe(true);
    expect(nodes.some((node) => node.role === "image" && node.name === "SEARCHABLE SOURCE TITLE")).toBe(false);
  }, 60_000);

  it("wires --real-text through the single-frame capture CLI", async () => {
    const input = join(tempRoot, "cli-input.html");
    const output = join(tempRoot, "cli-output.svg");
    writeFileSync(input, `<!doctype html><style>body{font:20px Arial}</style><p>CLI searchable source</p>`);
    await runCapture([input, "--real-text", "--no-fonts-ready", "--wait", "1", "--quiet", "--output", output], "");
    const svg = readFileSync(output, "utf8");
    expect(svg).toContain('data-domotion-real-text-layer="true"');
    expect(svg).toContain("CLI searchable source");
  }, 60_000);
});
