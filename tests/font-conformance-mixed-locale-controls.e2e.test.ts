import { chromium, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const compatibility = 0x2f900;
const emptyDocument =
  '<!doctype html><html lang="en"><style>body{margin:0}#w{font-family:system-ui;font-size:16px}.c{display:inline-block;width:24px;height:24px;overflow:hidden;white-space:pre;font-style:normal}</style><div id="w"></div></html>';

type Cell = {
  cp: number;
  lang: string;
  text?: string;
  spacing?: string;
  cssLocale?: string;
  features?: string;
  direction?: "ltr" | "rtl";
};

function cellHtml(cell: Cell): string {
  const style = [
    cell.spacing && `letter-spacing:${cell.spacing}`,
    cell.cssLocale && `-webkit-locale:${cell.cssLocale}`,
    cell.features && `font-feature-settings:${cell.features}`,
    cell.direction && `direction:${cell.direction};unicode-bidi:bidi-override`,
  ]
    .filter(Boolean)
    .join(";");
  const content = [...(cell.text ?? String.fromCodePoint(cell.cp))]
    .map((character) => `&#x${character.codePointAt(0)!.toString(16)};`)
    .join("");
  return `<i class="c" lang="${cell.lang}" style="${style.replaceAll('"', "&quot;")}">${content}</i>`;
}

async function addCell(page: Page, cell: Cell): Promise<void> {
  await page.locator("#w").evaluate((wrapper, html) => wrapper.insertAdjacentHTML("beforeend", html), cellHtml(cell));
  await page.screenshot();
}

async function faces(page: Page): Promise<{ face: string; locale: string }[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".c" });
    const cells = await page.locator(".c").evaluateAll((elements) =>
      elements.map((element) => ({
        locale: getComputedStyle(element).webkitLocale,
        glyphCount: Array.from(element.textContent ?? "").length,
      })),
    );
    return Promise.all(
      nodeIds.map(async (nodeId, index) => {
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        expect(fonts).toHaveLength(1);
        expect(fonts[0].glyphCount).toBe(cells[index].glyphCount);
        return { face: fonts[0].postScriptName, locale: cells[index].locale };
      }),
    );
  } finally {
    await cdp.detach();
  }
}

async function scenario(
  seed: Cell,
  target: Cell,
  afterSeed?: (page: Page) => Promise<void>,
): Promise<{ face: string; locale: string }[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(emptyDocument);
    await addCell(page, seed);
    const seedFace = (await faces(page))[0];
    await afterSeed?.(page);
    await addCell(page, target);
    const finalFaces = await faces(page);
    return [seedFace, finalFaces.at(-1)!];
  } finally {
    await browser.close();
  }
}

describe.runIf(process.platform === "darwin")("macOS mixed-locale shape transition controls", () => {
  it("distinguishes computed locale from the retained English-first face", async () => {
    const result = await scenario({ cp: compatibility, lang: "en" }, { cp: compatibility, lang: "zh-Hans" });
    expect(result).toEqual([
      { face: ".SFNS-Regular", locale: '"en"' },
      { face: ".SFNS-Regular", locale: '"zh-Hans"' },
    ]);
  }, 60_000);

  it("lets an explicit CSS locale override the English lang and select Chinese primary shaping", async () => {
    const result = await scenario(
      { cp: compatibility, lang: "en", cssLocale: '"zh-Hans"' },
      { cp: compatibility, lang: "zh-Hans" },
    );
    expect(result).toEqual([
      { face: "PingFangSC-Regular", locale: '"zh-Hans"' },
      { face: "PingFangSC-Regular", locale: '"zh-Hans"' },
    ]);
  }, 60_000);

  it.each([
    ["seed", { cp: compatibility, lang: "en", spacing: "0.1px" }, { cp: compatibility, lang: "zh-Hans" }],
    ["target", { cp: compatibility, lang: "en" }, { cp: compatibility, lang: "zh-Hans", spacing: "0.1px" }],
  ] as const)(
    "bypasses the retained face with %s letter spacing",
    async (_name, seed, target) => {
      const result = await scenario(seed, target);
      expect(result[0].face).toBe(".SFNS-Regular");
      expect(result[1].face).toBe("PingFangSC-Regular");
    },
    60_000,
  );

  it.each([
    ["seed", { cp: compatibility, lang: "en", features: '"ss01" 1' }, { cp: compatibility, lang: "zh-Hans" }],
    ["target", { cp: compatibility, lang: "en" }, { cp: compatibility, lang: "zh-Hans", features: '"ss01" 1' }],
  ] as const)(
    "bypasses the retained face with %s noninitial font features",
    async (_name, seed, target) => {
      const result = await scenario(seed, target);
      expect(result[0].face).toBe(".SFNS-Regular");
      expect(result[1].face).toBe("PingFangSC-Regular");
    },
    60_000,
  );

  it.each([
    ["remove only", false, false, ".SFNS-Regular"],
    ["new document without GC", true, false, ".SFNS-Regular"],
    ["new document and GC", true, true, "PingFangSC-Regular"],
  ] as const)(
    "%s before adding the Chinese cell",
    async (_name, navigate, collect, expected) => {
      const result = await scenario(
        { cp: compatibility, lang: "en" },
        { cp: compatibility, lang: "zh-Hans" },
        async (page) => {
          await page
            .locator(".c")
            .first()
            .evaluate((element) => element.remove());
          if (navigate) await page.setContent(emptyDocument);
          if (collect) {
            const cdp = await page.context().newCDPSession(page);
            for (let attempt = 0; attempt < 3; attempt++) await cdp.send("HeapProfiler.collectGarbage");
            await cdp.detach();
          }
        },
      );
      expect(result[1].face).toBe(expected);
    },
    60_000,
  );

  it("does not transfer the English result to a different scalar", async () => {
    const result = await scenario({ cp: 0x0100, lang: "en" }, { cp: compatibility, lang: "zh-Hans" });
    expect(result.map(({ face }) => face)).toEqual([".SFNS-Regular", "PingFangSC-Regular"]);
  }, 60_000);

  it.each([
    ["30 UTF-16 units", 15, ".SFNS-Regular"],
    ["32 UTF-16 units", 16, "PingFangSC-Regular"],
  ] as const)(
    "applies the source text-length limit at %s",
    async (_name, count, expected) => {
      const text = String.fromCodePoint(compatibility).repeat(count);
      const result = await scenario(
        { cp: compatibility, text, lang: "en" },
        { cp: compatibility, text, lang: "zh-Hans" },
      );
      expect(result[0].face).toBe(".SFNS-Regular");
      expect(result[1].face).toBe(expected);
    },
    60_000,
  );

  it("separates left-to-right and right-to-left shape-cache entries", async () => {
    const result = await scenario(
      { cp: compatibility, lang: "en", direction: "ltr" },
      { cp: compatibility, lang: "zh-Hans", direction: "rtl" },
    );
    expect(result.map(({ face }) => face)).toEqual([".SFNS-Regular", "PingFangSC-Regular"]);
  }, 60_000);
});
