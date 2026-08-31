import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvg,
  launchChromium,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("generated URL image intrinsic paint", () => {
  it("keeps a 128px SVG paint owner separate from its 24px pseudo layout slot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "domotion-generated-image-"));
    const htmlPath = path.join(dir, "fixture.html");
    await Promise.all([
      writeFile(path.join(dir, "asset.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="orange"/></svg>'),
      writeFile(htmlPath, '<style>body{margin:0}#host{font:16px/24px Arial}#host::before{content:url("asset.svg");display:inline-block;width:24px;height:24px;vertical-align:middle;margin-right:6px}</style><p id="host">text</p>'),
    ]);
    const page = await env!.browser.newPage({ viewport: { width: 1024, height: 768 } });
    try {
      await page.goto(pathToFileURL(htmlPath).href);
      const result = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
      const all = [...result.tree];
      for (let index = 0; index < all.length; index++) all.push(...(all[index].children ?? []));
      const record = all.flatMap((entry) => entry.pseudoFragments ?? []).find((entry) =>
        entry.reason === "generated URL image intrinsic paint exceeds its pseudo layout slot"
          || entry.contentItems.some((item) => item.kind === "image"));
      expect(record).toMatchObject({
        status: "terminal-raster",
        reason: "generated URL image intrinsic paint exceeds its pseudo layout slot",
      });
      expect(all.flatMap((entry) => entry.pseudoImages ?? [])).toHaveLength(0);
      const svg = elementTreeToSvg(result.tree, 1024, 768);
      expect(svg).toContain('data-domotion-pseudo-owner="chromium-raster"');
      expect(svg).toMatch(/width="128" height="128" preserveAspectRatio="none"/);
    } finally {
      await page.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
