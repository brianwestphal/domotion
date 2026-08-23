import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { captureElementTree, captureElementTreeEnvelope } from "../src/capture/index.js";
import type { CapturedElement, CapturedTreeEnvelope } from "../src/capture/types.js";
import { promoteCapturedSubtree } from "../src/capture/tree-envelope.js";
import { capturedSessionGenericFamilies, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { getSessionGenericFamilyOverrides, setSessionGenericFamilyOverrides } from "../src/render/font-resolution.js";
import { ensureSessionGenericFamilyOverrides, probePageGenericFamilies, probeSessionGenericFamilies } from "../src/capture/generic-font-probe.js";

async function defaultCommonFamilyNames(context: BrowserContext, page: import("@playwright/test").Page): Promise<{ serif: string; sans: string; mono: string }> {
  await page.setContent("<!doctype html><body><span id=s style='font:32px serif'>A</span><span id=n style='font:32px sans-serif'>A</span><span id=m style='font:32px monospace'>A</span></body>");
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const read = async (selector: string): Promise<string> => {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      return fonts.reduce((best, font) => best == null || font.glyphCount > best.glyphCount ? font : best, null as (typeof fonts)[number] | null)!.familyName;
    };
    return { serif: await read("#s"), sans: await read("#n"), mono: await read("#m") };
  } finally {
    await cdp.detach();
  }
}

describe("the live session generic-family probe", () => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  beforeAll(async () => {
    browser = await chromium.launch();
    context = await browser.newContext();
  });

  afterAll(async () => {
    setSessionGenericFamilyOverrides(null);
    await context?.close();
    await browser?.close();
  });

  it("returns stable Common and per-script painted-family answers", async () => {
    const result = await probeSessionGenericFamilies(context!);
    expect(result).not.toBeNull();
    expect([...result!.common.keys()]).toEqual([
      "standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math",
    ]);
    for (const script of [
      "KATAKANA_OR_HIRAGANA", "HANGUL", "SIMPLIFIED_HAN", "TRADITIONAL_HAN",
    ]) {
      expect([...result!.byScript.get(script)!.keys()])
        .toEqual(["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"]);
    }
  });

  it("observes a controlled per-page Inspector preference mutation", async () => {
    const page = await context!.newPage();
    const families = await defaultCommonFamilyNames(context!, page);
    const before = await ensureSessionGenericFamilyOverrides(page);
    const session = await context!.newCDPSession(page);
    try {
      await session.send("Page.setFontFamilies", {
        fontFamilies: {
          standard: families.sans,
          serif: families.sans,
          sansSerif: families.serif,
          fixed: families.serif,
          cursive: families.mono,
          fantasy: families.serif,
          math: families.sans,
        },
        forScripts: [{
          script: "jpan",
          fontFamilies: { standard: families.sans, serif: families.sans, sansSerif: families.serif, fixed: families.serif },
        }],
      });
      const result = await ensureSessionGenericFamilyOverrides(page);
      expect(result).not.toBeNull();
      expect(result!.common.get("serif")).not.toBe(before!.common.get("serif"));
      expect(result!.common.get("sans-serif")).not.toBe(before!.common.get("sans-serif"));
      expect(result!.common.get("monospace")).not.toBe(before!.common.get("monospace"));
      expect(result!.byScript.get("KATAKANA_OR_HIRAGANA")!.get("serif"))
        .not.toBe(before!.byScript.get("KATAKANA_OR_HIRAGANA")!.get("serif"));
    } finally {
      await session.detach();
      await page.close();
    }
  });

  it("is isolated from hostile author-important universal font rules", async () => {
    const page = await context!.newPage();
    await page.setContent("<!doctype html><body>clean</body>");
    const clean = await probePageGenericFamilies(page);
    await page.setContent("<!doctype html><style>html,body,*{display:none!important;visibility:hidden!important;content-visibility:hidden!important;font-family:fantasy!important;font-size:3px!important}</style><body>hostile</body>");
    const hostile = await probePageGenericFamilies(page);
    expect(hostile).not.toBeNull();
    expect([...hostile!.common]).toEqual([...clean!.common]);
    expect([...hostile!.byScript].map(([script, families]) => [script, [...families]]))
      .toEqual([...clean!.byScript].map(([script, families]) => [script, [...families]]));
  });

  it("carries page-owned settings on the captured tree without mutating process-global render state", async () => {
    const page = await context!.newPage();
    await page.setContent("<!doctype html><body><span style='font:32px serif'>Regna</span></body>");
    setSessionGenericFamilyOverrides(null);
    try {
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 120 });
      expect(tree[0]?.sessionGenericFamilies?.source).toBe("chromium-platform-fonts-v1");
      expect(tree[0]?.sessionGenericFamilies?.common.serif).toBeTruthy();
      expect(getSessionGenericFamilyOverrides()).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("retains Page authority through JSON and descendant promotion into a render root", async () => {
    const page = await context!.newPage();
    await page.setContent("<!doctype html><body><main><section><span style='font:32px serif'>promoted</span></section></main></body>");
    setSessionGenericFamilyOverrides(null);
    try {
      const captured = await captureElementTreeEnvelope(
        page,
        "body",
        { x: 0, y: 0, width: 400, height: 120 },
      );
      const parsed = JSON.parse(JSON.stringify(captured)) as CapturedTreeEnvelope;
      const find = (nodes: CapturedElement[]): CapturedElement | undefined => {
        for (const node of nodes) {
          if (node.text.includes("promoted")) return node;
          const child = find(node.children);
          if (child != null) return child;
        }
        return undefined;
      };
      const descendant = find(parsed.tree);
      expect(descendant).toBeDefined();
      const promoted = promoteCapturedSubtree(parsed, descendant!);
      expect(promoted.sessionGenericFamilies).toEqual(parsed.sessionGenericFamilies);
      expect(promoted.tree[0].sessionGenericFamilies).toBeUndefined();
      expect(capturedSessionGenericFamilies(promoted)?.common.get("serif"))
        .toBe(parsed.sessionGenericFamilies!.common.serif);
      expect(elementTreeToSvgInner(promoted, 400, 120)).toContain("promoted");
      expect(getSessionGenericFamilyOverrides()).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("includes closed-shadow and response-header languages in the Page probe", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Language", "th");
      response.end(`<!doctype html><body><x-host></x-host><script>
        const root = document.querySelector("x-host").attachShadow({ mode: "closed" });
        root.innerHTML = "<span lang=ka>shadow language</span>";
      </script></body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const page = await context!.newPage();
    try {
      const { port } = server.address() as AddressInfo;
      await page.goto(`http://127.0.0.1:${port}/`);
      const result = await probePageGenericFamilies(page);
      expect(result).not.toBeNull();
      expect([...result!.byScript.get("THAI")!.keys()])
        .toEqual(["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"]);
      expect([...result!.byScript.get("GEORGIAN")!.keys()])
        .toEqual(["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"]);
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error)));
    }
  });
});
