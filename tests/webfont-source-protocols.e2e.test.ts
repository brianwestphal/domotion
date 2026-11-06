import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { discoverAndRegisterWebfonts } from "../src/capture/index.js";
import { createTextEngineSession } from "../src/render/text-engine.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { FIXTURE_FONT_CSS, FIXTURE_MONO_FAMILY, FIXTURE_SERIF_FAMILY } from "./fixture-fonts.js";

// Playwright's request API rejects `data:` and `file:` URLs, so webfont
// discovery used to report every such @font-face source as failed and never
// register it. `data:` is now decoded locally and a `file:` page's `file:`
// sources (and its `file:` stylesheets, which Chrome treats as opaque-origin
// and so reach the cross-origin path) are read from disk.

const SERIF_TTF = join(
  import.meta.dirname,
  "..",
  "packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf",
);

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium({ headless: true });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});

describe("webfont discovery for data: and file: sources", () => {
  it("registers data: URL @font-face faces from an inline <style>", async () => {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>${FIXTURE_FONT_CSS}</style><p>x</p>`);
    await page.evaluate(() => document.fonts.ready);
    const report = await discoverAndRegisterWebfonts(page, [], createTextEngineSession());
    expect(report.map((r) => [r.family, r.ok, r.error])).toEqual([
      [FIXTURE_MONO_FAMILY, true, undefined],
      [FIXTURE_SERIF_FAMILY, true, undefined],
    ]);
    await page.close();
  });

  it("registers file: faces of a file: page, including those declared in a linked file: stylesheet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webfont-file-"));
    copyFileSync(SERIF_TTF, join(dir, "serif.ttf"));
    writeFileSync(join(dir, "linked.css"), `@font-face { font-family: Linked; src: url(serif.ttf); }`);
    writeFileSync(
      join(dir, "page.html"),
      `<!doctype html><link rel="stylesheet" href="linked.css">` +
        `<style>@font-face { font-family: Inline; src: url(serif.ttf); }</style>` +
        `<p style="font-family: Linked">a</p><p style="font-family: Inline">b</p>`,
    );
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(dir, "page.html")).href);
    await page.evaluate(() => document.fonts.ready);
    const report = await discoverAndRegisterWebfonts(page, [], createTextEngineSession());
    const byFamily = Object.fromEntries(report.filter((r) => r.source === "font-face").map((r) => [r.family, r.ok]));
    expect(byFamily).toEqual({ Inline: true, Linked: true });
    await page.close();
  });
});
