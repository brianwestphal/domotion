import { chromium, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

const compatibility = 0x2f900;
const emptyDocument =
  '<!doctype html><html lang="en"><style>body{margin:0}#w{font-family:system-ui;font-size:16px}.c{display:inline-block;width:24px;height:24px;overflow:hidden;white-space:pre;font-style:normal}</style><div id="w"></div></html>';

type Cell = { cp: number; lang: string; spacing?: string; cssLocale?: string };

function cellHtml(cell: Cell): string {
  const style = [cell.spacing && `letter-spacing:${cell.spacing}`, cell.cssLocale && `-webkit-locale:${cell.cssLocale}`]
    .filter(Boolean)
    .join(";");
  return `<i class="c" lang="${cell.lang}" style="${style}">&#x${cell.cp.toString(16)};</i>`;
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
    const locales = await page
      .locator(".c")
      .evaluateAll((cells) => cells.map((element) => getComputedStyle(element).webkitLocale));
    return Promise.all(
      nodeIds.map(async (nodeId, index) => {
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        expect(fonts).toHaveLength(1);
        expect(fonts[0].glyphCount).toBe(1);
        return { face: fonts[0].postScriptName, locale: locales[index] };
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

  it("keeps lang-owned locale when an inline CSS locale tries to override it", async () => {
    const result = await scenario(
      { cp: compatibility, lang: "en", cssLocale: '"zh-Hans"' },
      { cp: compatibility, lang: "zh-Hans" },
    );
    expect(result).toEqual([
      { face: ".SFNS-Regular", locale: '"en"' },
      { face: ".SFNS-Regular", locale: '"zh-Hans"' },
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
});
