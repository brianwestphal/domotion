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

import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import type { CapturedSessionGenericFamilies } from "./types.js";
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
  // Full Chrome profile preferences are not limited to Playwright's four
  // macOS/seven Windows table entries. These three are standing controls for
  // ordinary Latin plus two settings scripts absent from Playwright's table;
  // every additional language actually present in the captured page is added
  // dynamically below.
  { lang: "en", text: "A" },
  { lang: "he", text: "A" },
  { lang: "hi", text: "A" },
] as const;
const SCRIPT_PROBED_GENERICS = PROBED_GENERICS;

export interface SessionGenericFamilyProbe {
  common: ReadonlyMap<string, string>;
  /** UScriptCode name → generic keyword → painted family. */
  byScript: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export function serializeSessionGenericFamilyProbe(
  probe: SessionGenericFamilyProbe,
): CapturedSessionGenericFamilies {
  return {
    source: "chromium-platform-fonts-v1",
    common: Object.fromEntries(probe.common),
    byScript: Object.fromEntries(
      [...probe.byScript].map(([script, families]) => [script, Object.fromEntries(families)]),
    ),
  };
}

export function deserializeSessionGenericFamilyProbe(
  probe: CapturedSessionGenericFamilies,
): SessionGenericFamilyProbe {
  return {
    common: new Map(Object.entries(probe.common)),
    byScript: new Map(
      Object.entries(probe.byScript).map(([script, families]) => [script, new Map(Object.entries(families))]),
    ),
  };
}

interface ProbeTarget {
  id: string;
  generic: string;
  text: string;
  lang: string | null;
  script: string | null;
}

export function genericFamilyProbeTargets(additionalLanguages: readonly string[] = []): ProbeTarget[] {
  const common = PROBED_GENERICS.map((generic, i) => ({
    id: `gc${i}`, generic, text: "Regna", lang: null, script: null,
  }));
  const scriptedInputs = [...SCRIPT_PROBES, ...additionalLanguages.map((lang) => ({ lang, text: "A" }))]
    .filter(({ lang }) => lang.trim() !== "")
    .filter((entry, index, entries) => entries.findIndex((candidate) =>
      localeToScriptCodeForFontSelection(candidate.lang) === localeToScriptCodeForFontSelection(entry.lang)) === index);
  const scripted = scriptedInputs.flatMap(({ lang, text }, scriptIndex) =>
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

let probeDocumentSequence = 0;

async function readPageGenericFamilies(
  page: Page,
  cdp: CDPSession,
  targets: ProbeTarget[],
): Promise<SessionGenericFamilyProbe | null> {
  const containerId = `__domotion_generic_probe_${++probeDocumentSequence}`;
  const rootStyles = await page.evaluate(({ id, rows }) => {
    const prior = {
      html: document.documentElement.getAttribute("style"),
      body: document.body?.getAttribute("style") ?? null,
      bodyPresent: document.body != null,
    };
    for (const root of [document.documentElement, document.body]) {
      if (root == null) continue;
      root.style.setProperty("display", "block", "important");
      root.style.setProperty("visibility", "visible", "important");
      root.style.setProperty("content-visibility", "visible", "important");
    }
    document.getElementById(id)?.remove();
    const container = document.createElement("div");
    container.id = id;
    container.setAttribute("aria-hidden", "true");
    container.setAttribute("data-domotion-generic-probe", "");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      left: "-100000px",
      top: "0",
      display: "block",
      visibility: "visible",
      "content-visibility": "visible",
      "white-space": "normal",
      contain: "strict",
      width: "4000px",
      height: "4000px",
      "pointer-events": "none",
    })) container.style.setProperty(property, value, "important");
    for (const row of rows) {
      const span = document.createElement("span");
      span.id = `${id}_${row.id}`;
      if (row.lang != null) span.lang = row.lang;
      // Inline author-important declarations beat any hostile page author
      // rule, including `* { font-family: ... !important }`. A user-origin
      // important rule remains allowed to win because that is part of the
      // launched session we are deliberately measuring.
      span.style.setProperty("all", "initial", "important");
      span.style.setProperty("display", "block", "important");
      span.style.setProperty("font-size", "32px", "important");
      span.style.setProperty("line-height", "normal", "important");
      if (row.generic !== "standard") span.style.setProperty("font-family", row.generic, "important");
      span.textContent = row.text;
      container.appendChild(span);
    }
    (document.documentElement ?? document).appendChild(container);
    return prior;
  }, { id: containerId, rows: targets });

  try {
    await page.evaluate(() => document.fonts.ready);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const common = new Map<string, string>();
    const byScript = new Map<string, Map<string, string>>();
    for (const target of targets) {
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `#${containerId}_${target.id}`,
      });
      if (nodeId === 0) continue;
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const primary = fonts.reduce(
        (best, font) => (best == null || font.glyphCount > best.glyphCount ? font : best),
        null as (typeof fonts)[number] | null,
      );
      if (primary == null || primary.familyName === "") continue;
      const faceName = primary.postScriptName || primary.familyName;
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
  } finally {
    await page.evaluate(({ id, prior }) => {
      document.getElementById(id)?.remove();
      if (prior.html == null) document.documentElement.removeAttribute("style");
      else document.documentElement.setAttribute("style", prior.html);
      if (prior.bodyPresent && document.body != null) {
        if (prior.body == null) document.body.removeAttribute("style");
        else document.body.setAttribute("style", prior.body);
      }
    }, { id: containerId, prior: rootStyles }).catch(() => {});
  }
}

/** Probe the exact page that will be captured. This observes profile defaults,
 * Playwright's injected table, and any later per-page CDP preference mutation
 * without navigating or replacing the caller's document. */
export async function probePageGenericFamilies(
  page: Page,
): Promise<SessionGenericFamilyProbe | null> {
  let cdp: CDPSession | null = null;
  try {
    const languages = (await Promise.all(page.frames().map(async (frame) => {
      try {
        return await frame.evaluate(() => [
          document.documentElement?.lang ?? "",
          ...Array.from(document.querySelectorAll("[lang]"), (element) => (element as HTMLElement).lang),
        ]);
      } catch {
        return [] as string[];
      }
    }))).flat();
    const targets = genericFamilyProbeTargets(languages);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const first = await readPageGenericFamilies(page, cdp, targets);
    const second = await readPageGenericFamilies(page, cdp, targets);
    if (probeResultsEqual(first, second)) return second;
    const third = await readPageGenericFamilies(page, cdp, targets);
    return probeResultsEqual(second, third) ? third : null;
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

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
    await page.setContent("<!DOCTYPE html><meta charset=utf-8><body></body>");
    return await probePageGenericFamilies(page);
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
 * Default-on entry point called from the capture funnel: probe the exact Page
 * being captured and return the result for serialization on the captured tree.
 * No process-global renderer state is changed. No-op when
 * `DOMOTION_GENERIC_PROBE=0`; never throws; deliberately re-probes every
 * capture because another CDP session can mutate Page settings at any time.
 */
export async function ensureSessionGenericFamilyOverrides(
  page: Page,
): Promise<SessionGenericFamilyProbe | null> {
  if (!genericProbeArmed()) return null;
  // Do not cache by Page: Page.setFontFamilies is guarded once per
  // InspectorPageAgent SESSION, so another CDP session can legitimately
  // mutate the same page between two captures. Re-probing is the only source-
  // honest invalidation policy available through the public protocol.
  return await probePageGenericFamilies(page);
}
