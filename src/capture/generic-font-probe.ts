// Session generic-family probe (flag-gated prototype, default OFF).
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
// for every session. When `DOMOTION_GENERIC_PROBE=1`, we instead ask the
// capture session itself — render one hidden page with a span per generic and
// read the painted family via CDP `CSS.getPlatformFontsForNode` — and route
// the generic keywords to those families for the rest of the process
// (`setSessionGenericFamilyOverrides` in `src/render/font-resolution.ts`).
// Default OFF: the calibrated static generic routes are unchanged unless the
// flag is set.

import type { BrowserContext, Page } from "@playwright/test";
import { setSessionGenericFamilyOverrides } from "../render/font-resolution.js";

/** The generic keywords probed. `standard` (no font-family) is intentionally
 *  excluded: capture reads the computed `font-family` stack, so an element
 *  with no declared family is handled by the renderer's default route, not by
 *  a generic keyword match. */
const PROBED_GENERICS = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "math"] as const;

export function genericProbeArmed(): boolean {
  return process.env.DOMOTION_GENERIC_PROBE === "1";
}

/** Contexts already probed (or being probed) this process — one probe per
 *  browser context is enough: the settings are per-session, applied by
 *  Playwright at page init, and stable once a page has painted. */
const probedContexts = new WeakSet<BrowserContext>();

/**
 * Ask THIS capture session which family each CSS generic keyword paints.
 * Returns a map from generic keyword to the painted platform family name
 * (e.g. "monospace" -> "Courier"), or null when the probe fails (non-CDP
 * browser, closed context, ...). Never throws.
 */
export async function probeSessionGenericFamilies(
  context: BrowserContext,
): Promise<ReadonlyMap<string, string> | null> {
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const spans = PROBED_GENERICS.map(
      (g, i) => `<span id="g${i}" style="font-family: ${g}; font-size: 32px;">Regna</span>`,
    ).join("<br>");
    await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><body>${spans}</body>`);
    await page.evaluate(() => document.fonts.ready);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const map = new Map<string, string>();
    for (let i = 0; i < PROBED_GENERICS.length; i++) {
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `#g${i}`,
      });
      if (nodeId === 0) continue;
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      // The span is single-script Latin text; take the font that painted the
      // most glyphs (there is essentially always exactly one entry).
      const primary = fonts.reduce(
        (best, f) => (best == null || f.glyphCount > best.glyphCount ? f : best),
        null as (typeof fonts)[number] | null,
      );
      if (primary != null && primary.familyName !== "") {
        map.set(PROBED_GENERICS[i], primary.familyName);
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

/**
 * Flag-gated entry point called from the capture funnel: probe the page's
 * browser context once and install the result as the session generic-family
 * overrides consulted by `matchFamilyNameToKey`. No-op unless
 * `DOMOTION_GENERIC_PROBE=1`; never throws; never re-probes a context.
 */
export async function ensureSessionGenericFamilyOverrides(page: Page): Promise<void> {
  if (!genericProbeArmed()) return;
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    return;
  }
  if (probedContexts.has(context)) return;
  probedContexts.add(context);
  const map = await probeSessionGenericFamilies(context);
  if (map != null) setSessionGenericFamilyOverrides(map);
}
