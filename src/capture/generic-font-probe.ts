// Session generic-family probe (default-on; explicitly disable with
// DOMOTION_GENERIC_PROBE=0).
//
// The concrete families behind the CSS generic keywords (`serif`,
// `sans-serif`, `monospace`, `cursive`, `fantasy`, `math`) are a property of
// the LAUNCHED browser session, not of Chromium's source. Three layers can
// supply them, and which one wins depends on how the browser was started:
//
//   1. `blink::web_pref::WebPreferences`'s constructor seeds only the `Zyyy`
//      (Common) key: standard/serif "Times New Roman", fixed "Menlo" on mac /
//      "Courier New" elsewhere, sans-serif "Arial", cursive "Script", fantasy
//      "Impact", math "Latin Modern Math"
//      (`third_party/blink/common/web_preferences/web_preferences.cc:25-41`,
//      rev 7d859f27).
//   2. The chrome preferences layer applies the per-platform, per-script
//      `.grd` tables (`chrome/browser/ui/prefs/prefs_tab_helper.cc:148-154` +
//      `chrome/app/resources/locale_settings_<platform>.grd`) — but only the
//      full Chrome binary runs it, and Playwright's default headless launch
//      starts the headless shell, which has no font-preference code at all
//      (zero `font_family` references under `headless/lib/`).
//   3. Playwright itself overrides both for every non-headful launch: it
//      calls CDP `Page.setFontFamilies` on each page with its own vendored
//      per-platform table, including per-script entries on mac/win
//      (`playwright-core/lib/server/chromium/crPage.js`,
//      `_setDefaultFontFamilies`, gated on `!options.headful`;
//      `defaultFontFamilies.js`). Measured in this harness's own launch path
//      on macOS: serif→Times, sans-serif→Helvetica, monospace→Courier,
//      cursive→Apple Chancery, fantasy→Papyrus — Playwright's table, not
//      Chromium's constructor and not the current `.grd` (whose fixed entry
//      is Menlo).
//
// Because the winning layer changes with the launch shape (headless shell vs
// full binary vs headed) and Playwright's CDP update can even lose a race
// against first layout on a loaded CI runner, no static table can be correct
// for every session. We therefore ask the
// capture session itself — render one hidden page with Common and per-script
// generic spans, read the painted family via CDP
// `CSS.getPlatformFontsForNode`, and route the generic keywords to those
// families for the rest of the process
// (`setSessionGenericFamilyOverrides` in `src/render/font-resolution.ts`).
// Static routes remain only as a degraded fallback when probing fails or is
// explicitly disabled.

import type { BrowserContext, Page } from "@playwright/test";
import { setSessionGenericFamilyOverrides } from "../render/font-resolution.js";
import { localeToScriptCodeForFontSelection } from "../render/generic-script-families.js";

/** Browser settings families that participate in Blink's declared-family
 *  list. `standard` is the implicit final family and therefore also owns the
 *  `.notdef` donor when every declared candidate is exhausted. */
const PROBED_GENERICS = ["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"] as const;
const SCRIPT_PROBES = [
  { lang: "ja", text: "A" },
  { lang: "ko", text: "A" },
  { lang: "zh-Hans", text: "A" },
  { lang: "zh-Hant", text: "A" },
  { lang: "ru", text: "A" },
  { lang: "ar", text: "A" },
  { lang: "el", text: "A" },
] as const;
const SCRIPT_PROBED_GENERICS = PROBED_GENERICS;

export interface SessionGenericFamilyProbe {
  common: ReadonlyMap<string, string>;
  /** UScriptCode name → generic keyword → painted family. */
  byScript: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface ProbeTarget {
  id: string;
  generic: string;
  text: string;
  lang: string | null;
  script: string | null;
}

export function genericFamilyProbeTargets(): ProbeTarget[] {
  const common = PROBED_GENERICS.map((generic, i) => ({
    id: `gc${i}`, generic, text: "Regna", lang: null, script: null,
  }));
  const scripted = SCRIPT_PROBES.flatMap(({ lang, text }, scriptIndex) =>
    SCRIPT_PROBED_GENERICS.map((generic, genericIndex) => ({
      id: `gs${scriptIndex}-${genericIndex}`,
      generic,
      text,
      lang,
      script: localeToScriptCodeForFontSelection(lang),
    })));
  return [...common, ...scripted];
}

export function genericProbeArmed(): boolean {
  return process.env.DOMOTION_GENERIC_PROBE !== "0";
}

/** One shared task per browser context. Concurrent captures await the same
 *  probe, and later captures reinstall that context's cached answer in case a
 *  different context has since replaced the process-global renderer state. */
const contextProbeTasks = new WeakMap<BrowserContext, Promise<SessionGenericFamilyProbe | null>>();

/**
 * Ask THIS capture session which family each CSS generic keyword paints.
 * Returns Common and script-keyed maps from generic keyword to painted
 * platform face name (preferentially PostScript, e.g. "monospace" ->
 * "Courier"), or null when the
 * probe fails or never stabilizes. Never throws.
 */
export async function probeSessionGenericFamilies(
  context: BrowserContext,
): Promise<SessionGenericFamilyProbe | null> {
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const targets = genericFamilyProbeTargets();
    const spans = targets.map(
      (target) => `<span id="${target.id}"${target.lang == null ? "" : ` lang="${target.lang}"`}`
        + ` style="${target.generic === "standard" ? "" : `font-family: ${target.generic}; `}font-size: 32px;">${target.text}</span>`,
    ).join("<br>");
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const read = async (): Promise<SessionGenericFamilyProbe | null> => {
      await page!.setContent(`<!DOCTYPE html><meta charset="utf-8"><body>${spans}</body>`);
      await page!.evaluate(() => document.fonts.ready);
      const { root } = await cdp.send("DOM.getDocument");
      const common = new Map<string, string>();
      const byScript = new Map<string, Map<string, string>>();
      for (const target of targets) {
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: `#${target.id}`,
        });
        if (nodeId === 0) continue;
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        const primary = fonts.reduce(
          (best, font) => (best == null || font.glyphCount > best.glyphCount ? font : best),
          null as (typeof fonts)[number] | null,
        );
        if (primary == null || primary.familyName === "") continue;
        // Family names can collapse distinct Chromium cuts. In particular,
        // CoreText reports family "Hiragino Kaku Gothic ProN" while Blink has
        // selected HiraKakuProN-W3; feeding only the family back through our
        // matcher re-selected the unrelated HiraginoSans-W4 face. Preserve
        // Chromium's concrete face identity whenever CDP supplies it.
        const faceName = primary.postScriptName ?? primary.familyName;
        if (target.script == null) common.set(target.generic, faceName);
        else {
          let scriptMap = byScript.get(target.script);
          if (scriptMap == null) {
            scriptMap = new Map();
            byScript.set(target.script, scriptMap);
          }
          scriptMap.set(target.generic, faceName);
        }
      }
      return common.size > 0 ? { common, byScript } : null;
    };

    // Playwright's Page.setFontFamilies update can race the first layout on a
    // loaded runner. Require two consecutive identical paints; a third pass
    // lets the settled Playwright values win over a constructor-default first.
    const first = await read();
    const second = await read();
    if (probeResultsEqual(first, second)) return second;
    const third = await read();
    return probeResultsEqual(second, third) ? third : null;
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

function probeResultsEqual(
  a: SessionGenericFamilyProbe | null,
  b: SessionGenericFamilyProbe | null,
): boolean {
  if (a == null || b == null) return a === b;
  const entries = (probe: SessionGenericFamilyProbe): string[] => [
    ...[...probe.common].map(([generic, family]) => `COMMON/${generic}/${family}`),
    ...[...probe.byScript].flatMap(([script, map]) =>
      [...map].map(([generic, family]) => `${script}/${generic}/${family}`)),
  ].sort();
  return JSON.stringify(entries(a)) === JSON.stringify(entries(b));
}

/**
 * Default-on entry point called from the capture funnel: probe the page's
 * browser context once and install the result as the session generic-family
 * overrides consulted by `matchFamilyNameToKey`. No-op unless
 * `DOMOTION_GENERIC_PROBE=0`; never throws; never re-probes a context.
 */
export async function ensureSessionGenericFamilyOverrides(page: Page): Promise<void> {
  if (!genericProbeArmed()) return;
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    return;
  }
  const existing = contextProbeTasks.get(context);
  if (existing != null) {
    const result = await existing;
    if (result != null) setSessionGenericFamilyOverrides(result);
    return;
  }
  const task = probeSessionGenericFamilies(context);
  contextProbeTasks.set(context, task);
  const result = await task;
  if (result != null) setSessionGenericFamilyOverrides(result);
}
