import { chromium } from "@playwright/test";
import {
  beginCharacterFallbackDocument,
  endCharacterFallbackDocument,
  splitTextIntoFontRunsShaped,
} from "@domotion/text-engine/testing";
import { describe, expect, it } from "vitest";
import {
  ChromeOracle,
  cjkCanonicalRendererFace,
  faceFor,
  ourFaceFor,
  prepareStack,
  type StackSpec,
} from "../tools/font-conformance.js";

const cps = [0x2f800, 0x2f900, 0x2fa00];
const stack: StackSpec = { fontFamily: "system-ui", fontSize: 16, fontWeight: 400, fontStyle: "normal" };

type ProbeCell = { cp: number; lang: string; text?: string };

function cell({ cp, lang, text }: ProbeCell): string {
  const content = [...(text ?? String.fromCodePoint(cp))]
    .map((scalar) => `&#x${scalar.codePointAt(0)!.toString(16)};`)
    .join("");
  return `<i class=c lang="${lang}">${content}</i>`;
}

async function browserFaces(cells: ProbeCell[], family = "system-ui"): Promise<string[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await page.setContent(
      "<!doctype html><html lang=en><style>body{margin:0}#w{display:flex;flex-wrap:wrap;" +
        `font-family:${family};font-size:16px;font-weight:400;font-style:normal}` +
        ".c{display:inline-block;width:24px;height:24px;overflow:hidden;font-style:inherit;white-space:pre}" +
        `</style><div id=w>${cells.map(cell).join("")}</div></html>`,
    );
    await page.screenshot();
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".c" });
    const faces: string[] = [];
    for (const [index, nodeId] of nodeIds.entries()) {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      expect(fonts).toHaveLength(1);
      expect(fonts[0].glyphCount).toBe([...(cells[index].text ?? String.fromCodePoint(cells[index].cp))].length);
      faces.push(fonts[0].postScriptName);
    }
    return faces;
  } finally {
    await browser.close();
  }
}

function rendererRunFaces(cells: ProbeCell[]): string[] {
  beginCharacterFallbackDocument();
  try {
    return cells.map(({ cp, text, lang }) => {
      const rs = prepareStack(stack, lang);
      if (rs == null) throw new Error("system-ui stack unavailable");
      const runs = splitTextIntoFontRunsShaped(
        text ?? String.fromCodePoint(cp),
        rs.primary,
        rs.primaryKey,
        400,
        16,
        0,
        undefined,
        lang,
        rs.chain,
        true,
        100,
        undefined,
        "system-ui",
      );
      expect(runs).toHaveLength(1);
      return faceFor(rs, runs[0].fontKey, true, runs[0].font).postscriptName ?? "";
    });
  } finally {
    endCharacterFallbackDocument();
  }
}

function oracleFaces(cells: { cp: number; lang: string }[], family = "system-ui"): string[] {
  beginCharacterFallbackDocument();
  try {
    return cells.map(({ cp, lang }) => {
      const rs = prepareStack({ ...stack, fontFamily: family }, lang);
      if (rs == null) throw new Error("system-ui stack unavailable");
      return cjkCanonicalRendererFace(cp, rs, ourFaceFor(cp, rs, lang)).postscriptName ?? "";
    });
  } finally {
    endCharacterFallbackDocument();
  }
}

describe.runIf(process.platform === "darwin")("macOS mixed-locale shape cache browser parity", () => {
  it("matches the native two-scalar canonical run after an English-first primary-only result", async () => {
    const text = "\u{2f900}\u{2fa00}";
    const fresh = [{ cp: 0x2f900, text, lang: "zh-Hans" }];
    const mixed = [{ cp: 0x2f900, text, lang: "en" }, ...fresh];
    expect(await browserFaces(fresh)).toEqual(["PingFangSC-Regular"]);
    expect(rendererRunFaces(fresh)).toEqual(["PingFangSC-Regular"]);
    expect(await browserFaces(mixed)).toEqual([".SFNS-Regular", ".SFNS-Regular"]);
    expect(rendererRunFaces(mixed)).toEqual([".SFNS-Regular", ".SFNS-Regular"]);
  }, 60_000);

  it("matches fresh Chinese and English-first documents for all three compatibility ideographs", async () => {
    const fresh = cps.map((cp) => ({ cp, lang: "zh-Hans" }));
    const mixed = [
      ...cps.map((cp) => ({ cp, lang: "en" })),
      ...cps.map((cp) => ({ cp, lang: "zh-Hans" })),
      ...cps.map((cp) => ({ cp, lang: "zh-Hant" })),
    ];
    expect(await browserFaces(fresh)).toEqual(Array(3).fill("PingFangSC-Regular"));
    expect(oracleFaces(fresh)).toEqual(Array(3).fill("PingFangSC-Regular"));
    expect(await browserFaces(mixed)).toEqual(Array(9).fill(".SFNS-Regular"));
    expect(oracleFaces(mixed)).toEqual(Array(9).fill(".SFNS-Regular"));
  }, 60_000);

  it("leaves a different English codepoint from poisoning the Chinese target", async () => {
    const cells = [
      { cp: 0x0100, lang: "en" },
      { cp: 0x2f900, lang: "zh-Hans" },
    ];
    expect(await browserFaces(cells)).toEqual([".SFNS-Regular", "PingFangSC-Regular"]);
    expect(oracleFaces(cells)[1]).toBe("PingFangSC-Regular");
  }, 60_000);

  it("follows the generic-family activation matrix", async () => {
    const cells = [
      { cp: 0x2f900, lang: "en" },
      { cp: 0x2f900, lang: "zh-Hans" },
    ];
    for (const [family, expected] of [
      ["fantasy", "Papyrus"],
      ["monospace", "Courier"],
      ["cursive", "PingFangSC-Regular"],
    ]) {
      const browser = await browserFaces(cells, family);
      const oracle = oracleFaces(cells, family);
      expect(browser[1]).toBe(expected);
      expect(oracle[1]).toBe(expected);
    }
  }, 60_000);

  it("clears weak shape results between synthetic stacks while reusing the Page", async () => {
    const browser = await chromium.launch({ headless: true });
    const oracle = await ChromeOracle.create(browser, 16, "en");
    try {
      const en = await oracle.facesFor([0x2f900], { ...stack, lang: "en" });
      expect(en[0][0].postScriptName).toBe(".SFNS-Regular");
      await oracle.clearWeakShapeResultsForNextStack();
      const zh = await oracle.facesFor([0x2f900], { ...stack, lang: "zh-Hans" });
      expect(zh[0][0].postScriptName).toBe("PingFangSC-Regular");
    } finally {
      await oracle.close();
      await browser.close();
    }
  }, 60_000);
});
