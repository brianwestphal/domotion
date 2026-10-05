import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  beginCharacterFallbackDocument,
  createFontRendererSession,
  endCharacterFallbackDocument,
  isGlyphHelperAvailable,
  splitTextIntoFontRunsShaped,
  stackPrimaryIsSystemUi,
  withFontRendererSession,
} from "@domotion/text-engine/testing";
import { probeWindowsSystemUiCjkContext, systemUiCjkStack } from "../tools/probe-windows-system-ui-cjk-context.js";
import { ChromeOracle, faceFor, prepareStack, primaryChromeFace } from "../tools/font-conformance.js";

interface Row {
  scenario: string;
  lang: string;
  codepoint: string;
  postScriptName: string | null;
}

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Windows system-ui CJK shape-cache transition", () => {
  it("drops a prior primary .notdef before a fresh synthetic stack in the same renderer", async () => {
    const browser = await chromium.launch();
    const oracle = await ChromeOracle.create(browser, 3, "en");
    try {
      const ask = async (lang: string): Promise<string | null> =>
        primaryChromeFace((await oracle.facesFor([0x2f800], systemUiCjkStack(lang)))[0] ?? [])?.postScriptName ?? null;
      const japanese = await ask("ja");
      expect(japanese).toBeTruthy();
      expect(await ask("zh-Hans")).toBe(japanese);
      await oracle.clearWeakShapeResultsForNextStack();
      const freshChinese = await ask("zh-Hans");
      expect(freshChinese).toBeTruthy();
      expect(freshChinese).not.toBe(japanese);
    } finally {
      await oracle.close();
      await browser.close();
    }
  }, 60_000);

  it("retains a prior primary .notdef for two Chinese compatibility scalars, then resets in a fresh context", async () => {
    expect(isGlyphHelperAvailable()).toBe(true);
    const out = join(mkdtempSync(join(tmpdir(), "domotion-windows-cjk-context-")), "report.json");
    expect(await probeWindowsSystemUiCjkContext(out)).toBe(0);
    const rows = (JSON.parse(readFileSync(out, "utf8")) as { data: { rows: Row[] } }).data.rows;
    expect(rows).toHaveLength(42);
    const face = (scenario: string, lang: string, cp: string): string | null => {
      const matches = rows.filter((row) => row.scenario === scenario && row.lang === lang && row.codepoint === cp);
      expect(matches, `${scenario}/${lang}/${cp}`).toHaveLength(1);
      return matches[0].postScriptName;
    };

    for (const lang of ["zh-Hans", "zh-Hant"]) {
      for (const cp of ["U+2F800", "U+2FA00"]) {
        const priorPrimary = face("forward-one-context", "ja", cp);
        const forward = face("forward-one-context", lang, cp);
        const reverse = face("reverse-one-context", lang, cp);
        const freshContext = face("fresh-context", lang, cp);
        const freshBrowser = face("fresh-browser", lang, cp);
        expect(priorPrimary).toBeTruthy();
        expect(forward).toBe(priorPrimary);
        expect(reverse).not.toBe(forward);
        expect(freshContext).toBe(reverse);
        expect(freshBrowser).toBe(reverse);
      }
      const control = face("forward-one-context", lang, "U+2F900");
      expect(control).toBeTruthy();
      expect(face("reverse-one-context", lang, "U+2F900")).toBe(control);
      expect(face("fresh-context", lang, "U+2F900")).toBe(control);
      expect(face("fresh-browser", lang, "U+2F900")).toBe(control);
    }
    for (const lang of ["ja", "ko"]) {
      for (const cp of ["U+2F800", "U+2FA00"]) {
        expect(face("reverse-one-context", lang, cp)).toBe(face("fresh-context", lang, cp));
      }
    }

    const splitterFaces = (langs: string[]): Map<string, string | null> => {
      const session = createFontRendererSession();
      const actual = new Map<string, string | null>();
      for (const lang of langs) {
        withFontRendererSession(session, () => {
          beginCharacterFallbackDocument();
          try {
            const spec = systemUiCjkStack(lang);
            const resolved = prepareStack(spec);
            expect(resolved, `prepared ${lang} stack`).not.toBeNull();
            for (const cp of [0x2f800, 0x2f900, 0x2fa00]) {
              const text = String.fromCodePoint(cp);
              const runs = splitTextIntoFontRunsShaped(
                text,
                resolved!.primary,
                resolved!.primaryKey,
                spec.fontWeight,
                spec.fontSize,
                resolved!.slant,
                resolved!.variationSettings,
                spec.lang,
                resolved!.chain,
                stackPrimaryIsSystemUi(spec.fontFamily, spec.lang),
                resolved!.stretch,
                undefined,
                spec.fontFamily,
              );
              expect(runs, `${lang}/U+${cp.toString(16)}`).toHaveLength(1);
              const postscriptName = faceFor(resolved!, runs[0].fontKey, true, runs[0].font).postscriptName;
              actual.set(`${lang}/U+${cp.toString(16).toUpperCase()}`, postscriptName);
            }
          } finally {
            endCharacterFallbackDocument();
          }
        });
      }
      return actual;
    };

    for (const [scenario, langs] of [
      ["forward-one-context", ["ja", "ko", "zh-Hans", "zh-Hant"]],
      ["reverse-one-context", ["zh-Hant", "zh-Hans", "ko", "ja"]],
    ] as const) {
      const actual = splitterFaces([...langs]);
      for (const lang of langs) {
        for (const cp of ["U+2F800", "U+2F900", "U+2FA00"]) {
          expect(actual.get(`${lang}/${cp}`), `${scenario}/${lang}/${cp}`).toBe(face(scenario, lang, cp));
        }
      }
    }
    for (const lang of ["zh-Hans", "zh-Hant"]) {
      const actual = splitterFaces([lang]);
      for (const cp of ["U+2F800", "U+2F900", "U+2FA00"]) {
        expect(actual.get(`${lang}/${cp}`), `fresh-context/${lang}/${cp}`).toBe(face("fresh-context", lang, cp));
      }
    }
  }, 120_000);
});
