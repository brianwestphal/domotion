import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import {
  buildVariableHintedFont,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKeyChain,
} from "@domotion/text-engine/testing";
import { launchChromium } from "../src/capture/index.js";
import { clearWebfonts, registerWebfont } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const mono = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
);
const fallback = buildVariableHintedFont({
  family: "Descriptor Fallback Fixture",
  firstCodePoint: 0x30,
  aXMax: 650,
  withOs2: true,
});
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  clearWebfonts();
  await closeBrowserSafely(browser);
});

it.each([
  {
    axis: "weight",
    selected: { weight: "400", style: "normal", stretch: "100%" },
    other: { weight: "700", style: "normal", stretch: "100%" },
    request: { weight: 400, slant: 0, stretch: 100 },
  },
  {
    axis: "style",
    selected: { weight: "400", style: "italic", stretch: "100%" },
    other: { weight: "400", style: "normal", stretch: "100%" },
    request: { weight: 400, slant: 14, stretch: 100 },
  },
  {
    axis: "stretch",
    selected: { weight: "400", style: "normal", stretch: "75%" },
    other: { weight: "400", style: "normal", stretch: "100%" },
    request: { weight: 400, slant: 0, stretch: 75 },
  },
])(
  "matches native selected face and advance after a $axis-group range exclusion",
  async ({ axis, selected, other, request }) => {
    const page = await browser.newPage();
    clearWebfonts();
    try {
      const face = (family: string, data: Buffer, descriptors: typeof selected, range?: string) =>
        `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${data.toString("base64")});font-weight:${descriptors.weight};font-style:${descriptors.style};font-stretch:${descriptors.stretch};${range ? `unicode-range:${range};` : ""}}`;
      await page.setContent(`<style>${face("Descriptor Group", mono, selected, "U+0041")}${face("Descriptor Group", mono, other, "U+0030")}${face("Descriptor Fallback", fallback, { weight: "400", style: "normal", stretch: "100%" })}
      span{font-family:'Descriptor Group','Descriptor Fallback';font-size:20px;font-weight:${request.weight};font-style:${request.slant ? "italic" : "normal"};font-stretch:${request.stretch}%;font-synthesis:none}
      #in-range{font-weight:${other.weight};font-style:${other.style};font-stretch:${other.stretch}}</style>
      <span id="excluded">0</span><span id="in-range">0</span>`);
      await page.evaluate(() => document.fonts.ready);
      const cdp = await page.context().newCDPSession(page);
      let excluded: { width: number; face: string };
      let inRange: { width: number; face: string };
      let version: { product: string; revision: string };
      try {
        const observedVersion = await cdp.send("Browser.getVersion");
        version = { product: observedVersion.product, revision: observedVersion.revision };
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const observe = async (selector: string) => {
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
          const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
          expect(fonts).toHaveLength(1);
          expect(fonts[0].isCustomFont).toBe(true);
          const width = await page.locator(selector).evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getBoundingClientRect().width;
          });
          return { width, face: fonts[0].postScriptName };
        };
        excluded = await observe("#excluded");
        inRange = await observe("#in-range");
      } finally {
        await cdp.detach();
      }
      expect(excluded.face).not.toBe("JetBrainsMono-Regular");
      expect(inRange.face).toBe("JetBrainsMono-Regular");
      expect(excluded.width).toBe(14);
      expect(inRange.width).toBe(12);

      for (const [descriptors, ranges] of [
        [selected, [[0x41, 0x41]]],
        [other, [[0x30, 0x30]]],
      ] as const)
        expect(
          registerWebfont(
            "Descriptor Group",
            Number(descriptors.weight),
            descriptors.style,
            mono,
            ranges.map(([a, b]) => [a, b]),
            descriptors.stretch,
            descriptors.weight,
            descriptors.style,
          ),
        ).toBe(true);
      expect(registerWebfont("Descriptor Fallback", 400, "normal", fallback, undefined, "100%", "400", "normal")).toBe(
        true,
      );
      const stack = '"Descriptor Group", "Descriptor Fallback"';
      const primary = resolveFont(stack, request.weight, 20, request.slant, undefined, request.stretch)!;
      const chain = resolveFontKeyChain(stack, undefined, { ...request, size: 20 });
      const resolved = resolveFontForCodepoint(
        0x30,
        primary,
        chain[0],
        request.weight,
        20,
        request.slant,
        undefined,
        undefined,
        chain,
        false,
        request.stretch,
      );
      expect(resolved.key).toBe("webfont:descriptor fallback");
      const font = resolved.fontOverride!;
      expect(font.postscriptName).toBe(excluded.face);
      const advance = font.glyphForCodePoint(0x30)?.advanceWidth;
      if (advance == null) throw new Error("Selected font has no zero advance");
      expect((advance / font.unitsPerEm) * 20).toBe(excluded.width);
      const output = resolve(
        process.env["DOMOTION_OUTPUT_DIR"] ?? (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
      );
      mkdirSync(output, { recursive: true });
      writeFileSync(
        join(output, `webfont-descriptor-group-${axis}.json`),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch,
            sourceCommit: process.env["GITHUB_SHA"],
            browser: version,
            request,
            excluded,
            inRange,
            engine: { key: resolved.key, face: font.postscriptName, advance: (advance / font.unitsPerEm) * 20 },
          },
          null,
          2,
        ),
      );
      console.log(
        "Webfont descriptor native witness:",
        JSON.stringify({ platform: process.platform, request, excluded, inRange }),
      );
    } finally {
      clearWebfonts();
      await page.close();
    }
  },
);
