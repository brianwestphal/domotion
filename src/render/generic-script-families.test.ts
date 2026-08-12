// Per-script generic-family resolution (mac/win) — the settings-mapped
// generics keyed on the run's content script, mirroring
// `FontSelector::FamilyNameFromSettings`'s `settings.<Generic>(script)`
// consult (`platform/fonts/font_selector.cc:72-91`, rev 7d859f27) with the
// values the capture session actually holds: Playwright's `forScripts` tables
// (`playwright-core/lib/server/chromium/defaultFontFamilies.js`, 1.59.1).
//
// Three concerns, each pinned separately:
//   1. DRIFT GUARD — our transcription must equal the INSTALLED
//      playwright-core's table, so a Playwright upgrade that changes the
//      values fails here instead of silently diverging from the session.
//   2. locale → script — `LocaleToScriptCodeForFontSelection`
//      (`platform/text/locale_to_script_mapping.cc:164-470`), including the
//      walk order details a partial transcription would get wrong.
//   3. resolver behavior — `resolveFontKey(family, lang)` moves the generics
//      per script on darwin/win32 and never on linux.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  localeToScriptCodeForFontSelection, scriptNameToCode,
  perScriptGenericFamily, firstAvailableOrFirst,
  PLAYWRIGHT_PER_SCRIPT_FAMILIES,
} from "./generic-script-families.js";
import {
  resolveFontKey, resolveFontKeyChain, setSessionGenericFamilyOverrides,
  getSystemFallbackResolution, setSystemFallbackResolution,
  clearFontResolutionCaches,
} from "./font-resolution.js";
import { withHostPlatform } from "./host-platform.js";

const require = createRequire(import.meta.url);

describe("drift guard: the transcription equals the installed playwright-core's table", () => {
  interface PwFontFamilies { standard?: string; fixed?: string; serif?: string; sansSerif?: string; cursive?: string; fantasy?: string; math?: string }
  interface PwPlatform { fontFamilies: PwFontFamilies; forScripts?: Array<{ script: string; fontFamilies: PwFontFamilies }> }
  // playwright-core's exports map does not expose internal subpaths, so
  // resolve the installed package root and require the file by absolute path
  // (the vendored table has no public export — it IS the internal file
  // crPage.js reads).
  const pwRoot = dirname(require.resolve("playwright-core/package.json"));
  const pw = (require(join(pwRoot, "lib", "server", "chromium", "defaultFontFamilies.js")) as {
    platformToFontFamilies: Record<string, PwPlatform>;
  }).platformToFontFamilies;

  it("mac/win forScripts match key-for-key after the ScriptNameToCode conversion the browser applies", () => {
    for (const [ourPlatform, pwPlatform] of [["darwin", "mac"], ["win32", "win"]] as const) {
      const ours = PLAYWRIGHT_PER_SCRIPT_FAMILIES[ourPlatform];
      expect(ours).toBeDefined();
      const theirs = pw[pwPlatform].forScripts ?? [];
      const theirsByCode = new Map(theirs.map((e) => [scriptNameToCode(e.script), e.fontFamilies]));
      expect(new Set(ours!.keys())).toEqual(new Set(theirsByCode.keys()));
      for (const [code, entry] of ours!) {
        expect(entry, `${ourPlatform} ${code}`).toEqual({ ...theirsByCode.get(code) });
      }
    }
  });

  it("linux has NO forScripts — the content script must never move a Linux generic", () => {
    expect(pw.linux.forScripts).toBeUndefined();
    expect(PLAYWRIGHT_PER_SCRIPT_FAMILIES.linux).toBeUndefined();
  });

  it("no platform's table carries a math key — the WebPreferences constructor value stays live", () => {
    for (const p of Object.values(pw)) {
      expect(p.fontFamilies.math).toBeUndefined();
      for (const s of p.forScripts ?? []) expect(s.fontFamilies.math).toBeUndefined();
    }
  });
});

describe("LocaleToScriptCodeForFontSelection (locale_to_script_mapping.cc:164-470, rev 7d859f27)", () => {
  it("maps the CJK content locales the per-script tables key on", () => {
    expect(localeToScriptCodeForFontSelection("ja")).toBe("KATAKANA_OR_HIRAGANA");
    expect(localeToScriptCodeForFontSelection("ja-JP")).toBe("KATAKANA_OR_HIRAGANA");
    expect(localeToScriptCodeForFontSelection("ko")).toBe("HANGUL");
    expect(localeToScriptCodeForFontSelection("zh")).toBe("SIMPLIFIED_HAN");
    expect(localeToScriptCodeForFontSelection("zh-CN")).toBe("SIMPLIFIED_HAN");
    expect(localeToScriptCodeForFontSelection("zh-Hans-SG")).toBe("SIMPLIFIED_HAN");
    expect(localeToScriptCodeForFontSelection("zh-TW")).toBe("TRADITIONAL_HAN");
    expect(localeToScriptCodeForFontSelection("zh-Hant")).toBe("TRADITIONAL_HAN");
    expect(localeToScriptCodeForFontSelection("yue")).toBe("TRADITIONAL_HAN");
  });

  it("maps the win32 per-script locales", () => {
    expect(localeToScriptCodeForFontSelection("ru")).toBe("CYRILLIC");
    expect(localeToScriptCodeForFontSelection("uk")).toBe("CYRILLIC");
    expect(localeToScriptCodeForFontSelection("ar")).toBe("ARABIC");
    expect(localeToScriptCodeForFontSelection("fa")).toBe("ARABIC");
    expect(localeToScriptCodeForFontSelection("el")).toBe("GREEK");
  });

  it("a 4ALPHA script subtag wins over the language row (the walk checks it before shortening)", () => {
    // Blink returns LATIN for ru-Latn — the script subtag terminates the walk
    // before the "ru" row is ever consulted. A partial transcription that
    // only carried the seven relevant scripts would answer CYRILLIC here.
    expect(localeToScriptCodeForFontSelection("ru-Latn")).toBe("LATIN");
  });

  it("a whole-tag language match terminates the walk even for scripts with no settings entry", () => {
    expect(localeToScriptCodeForFontSelection("hi")).toBe("DEVANAGARI");
    expect(localeToScriptCodeForFontSelection("en")).toBe("LATIN");
    expect(localeToScriptCodeForFontSelection("en-US")).toBe("LATIN");
  });

  it("an unknown tag exhausts to COMMON; '_' canonicalizes to '-'", () => {
    expect(localeToScriptCodeForFontSelection("xqz")).toBe("COMMON");
    expect(localeToScriptCodeForFontSelection("zh_TW")).toBe("TRADITIONAL_HAN");
  });
});

describe("firstAvailableOrFirst (font_cache.cc:220-227 → ui/gfx/font_list.cc:246)", () => {
  it("a single name returns as-is without an availability check", () => {
    expect(firstAvailableOrFirst("Songti SC", () => { throw new Error("must not probe"); })).toBe("Songti SC");
  });
  it("a leading-comma list takes the first available family", () => {
    expect(firstAvailableOrFirst(",PingFang SC,STHeiti", (f) => f === "STHeiti")).toBe("STHeiti");
    expect(firstAvailableOrFirst(",PingFang SC,STHeiti", (f) => f === "PingFang SC")).toBe("PingFang SC");
  });
  it("none available falls back to the first listed", () => {
    expect(firstAvailableOrFirst(",PingFang SC,STHeiti", () => false)).toBe("PingFang SC");
  });
});

describe("perScriptGenericFamily", () => {
  it("returns the Playwright value for a keyed (platform, script, generic)", () => {
    expect(perScriptGenericFamily("darwin", "ja", "serif")).toBe("Hiragino Mincho ProN");
    expect(perScriptGenericFamily("darwin", "ja", "sans-serif")).toBe("Hiragino Kaku Gothic ProN");
    expect(perScriptGenericFamily("darwin", "ja", "monospace")).toBe("Osaka-Mono");
    expect(perScriptGenericFamily("darwin", "ko", "serif")).toBe("AppleMyungjo");
    expect(perScriptGenericFamily("darwin", "zh-Hans", "sans-serif")).toBe(",PingFang SC,STHeiti");
    expect(perScriptGenericFamily("win32", "ru", "serif")).toBe("Times New Roman");
    expect(perScriptGenericFamily("win32", "ja", "monospace")).toBe("MS Gothic");
  });

  it("returns null for a missing script, a missing setting, or linux — Blink then falls to the Common entry", () => {
    expect(perScriptGenericFamily("darwin", "en", "serif")).toBeNull();
    expect(perScriptGenericFamily("darwin", "ja", "cursive")).toBeNull(); // mac jpan has no cursive key
    expect(perScriptGenericFamily("darwin", "ru", "serif")).toBeNull();   // cyrl is win-only
    expect(perScriptGenericFamily("linux", "ja", "serif")).toBeNull();
  });
});

// ── Resolver behavior ──
let prevResolver: boolean;
beforeAll(() => { prevResolver = getSystemFallbackResolution(); setSystemFallbackResolution(false); });
afterAll(() => { setSystemFallbackResolution(prevResolver); });
afterEach(() => { setSessionGenericFamilyOverrides(null); clearFontResolutionCaches(); });

describe("resolveFontKey(family, lang) moves the settings-mapped generics per script", () => {
  it("darwin: lang=ja + serif resolves Hiragino Mincho ProN — the measured session paint", () => {
    withHostPlatform("darwin", () => {
      // With the native helper: the exact installed family (Blink's plain
      // family lookup — sysfb:HiraMinProN-W3, the face Chrome reports).
      // Degraded tier (no helper): the curated hiragino-mincho key, which
      // maps to the same HiraMinProN faces.
      const key = resolveFontKey("serif", "ja");
      expect(key === "hiragino-mincho" || /^sysfb:HiraMinProN/.test(key)).toBe(true);
      expect(key).not.toBe("times");
    });
  });

  it("darwin: the Latin/Common locales keep the calibrated routes", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("serif")).toBe("times");
      expect(resolveFontKey("serif", "en")).toBe("times");
      expect(resolveFontKey("serif", "en-US")).toBe("times");
    });
  });

  it("darwin: a script entry that names no key for the generic falls to the Common route (mac jpan has no cursive/fantasy)", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey("cursive", "ja")).toBe("apple-chancery");
      expect(resolveFontKey("fantasy", "ja")).toBe("papyrus");
    });
  });

  it("a quoted generic spelling ignores the per-script tables too — it is a literal family name", () => {
    withHostPlatform("darwin", () => {
      expect(resolveFontKey('"serif", Georgia', "ja")).toBe("georgia");
    });
  });

  it.runIf(process.platform === "darwin")("the per-script entry outranks the session-probed Common-script override, mirroring the settings lookup order", () => {
    withHostPlatform("darwin", () => {
      setSessionGenericFamilyOverrides({ common: new Map([["serif", "Menlo"]]), byScript: new Map() });
      // Common script: the probe's answer wins.
      expect(resolveFontKey("serif")).toMatch(/^(?:menlo|sysfb:Menlo-Regular)$/);
      // Japanese script: settings.Serif(jpan) exists, so the Common-script
      // probe value must not preempt it (generic_font_family_settings.cc:105-107
      // falls back to Common only when the per-script entry is MISSING).
      const key = resolveFontKey("serif", "ja");
      expect(key === "hiragino-mincho" || /^sysfb:HiraMinProN/.test(key)).toBe(true);
      expect(key).not.toBe("menlo");
    });
  });

  it.runIf(process.platform === "darwin")("a session-probed per-script answer outranks the static Playwright transcription", () => {
    withHostPlatform("darwin", () => {
      setSessionGenericFamilyOverrides({
        common: new Map([["serif", "Georgia"]]),
        byScript: new Map([["KATAKANA_OR_HIRAGANA", new Map([["serif", "Menlo"]])]]),
      });
      expect(resolveFontKey("serif", "ja")).toMatch(/^(?:menlo|sysfb:Menlo-Regular)$/);
      expect(resolveFontKey("serif", "ja-JP")).toMatch(/^(?:menlo|sysfb:Menlo-Regular)$/);
      expect(resolveFontKey("serif")).toMatch(/^(?:georgia|sysfb:Georgia)$/);
    });
  });

  it("linux: lang never moves a generic (Playwright's linux table has no forScripts)", () => {
    withHostPlatform("linux", () => {
      expect(resolveFontKey("serif", "ja")).toBe(resolveFontKey("serif"));
      expect(resolveFontKey("monospace", "ja")).toBe(resolveFontKey("monospace"));
    });
  });

  it.runIf(process.platform === "darwin")("darwin host: lang=zh-Hans serif resolves the Songti SC face; ja sans-serif the Hiragino Sans key", () => {
    withHostPlatform("darwin", () => {
      // These resolve through the installed-font probe, so they are asserted
      // only on a real macOS host (the families ship with stock macOS). The
      // probe resolves the EXACT nominated family — measured against the
      // oracle: Chrome paints HiraKakuProN-W3 for lang=ja sans-serif, the
      // literal ProN family, not the curated Hiragino Sans sibling.
      expect(resolveFontKey("serif", "zh-Hans")).toMatch(/^sysfb:/);
      expect(resolveFontKey("sans-serif", "ja")).toMatch(/^sysfb:HiraKakuProN/);
      // jpan fixed nominates "Osaka-Mono", a legacy family recent macOS no
      // longer ships — where it is absent the nomination fails, the stack
      // exhausts, and the SCRIPT-KEYED STANDARD terminal takes over
      // (settings.Standard(jpan) = "Hiragino Kaku Gothic ProN"): measured,
      // Chrome paints HiraKakuProN-W3 for every codepoint of a bare
      // lang=ja `monospace` run, Latin included.
      const mono = resolveFontKey("monospace", "ja");
      expect(mono.startsWith("sysfb:")).toBe(true);
    });
  });

  it.runIf(process.platform === "darwin")("the chain ends with the script-keyed STANDARD family — Blink's FontDataAt list's final entry", () => {
    withHostPlatform("darwin", () => {
      // lang=zh-Hant `monospace`: the declared chain resolves Courier; a Han
      // codepoint Courier lacks is asked of settings.Standard(hant) =
      // ",PingFang TC,Heiti TC" BEFORE per-codepoint system fallback
      // (font_fallback_iterator.cc:167-179). Measured: Chrome paints Han from
      // PingFang TC while Latin stays Courier.
      const chain = resolveFontKeyChain("monospace", "zh-Hant");
      expect(chain[0]).toBe("courier");
      expect(chain.some((k) => /^sysfb:PingFangTC/.test(k))).toBe(true);
    });
  });

  it("win32: a per-script family that does not resolve on this host walks past to the next declared family, like a failed typeface creation", () => {
    withHostPlatform("win32", () => {
      // "Yu Mincho"/"MS PMincho" resolve only on a real Windows host; there
      // the key is a winfam:/sysfb: dynamic key. Elsewhere the nominated
      // family fails and the stack continues — Georgia here, the standard
      // terminal for a bare stack.
      const key = resolveFontKey("serif, Georgia", "ja");
      expect(key === "georgia" || key.startsWith("winfam:") || key.startsWith("sysfb:")).toBe(true);
      expect(key).not.toBe("times");
    });
  });
});
