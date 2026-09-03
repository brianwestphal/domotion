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
// `CSS.getPlatformFontsForNode`, serialize those Page-owned answers with the
// captured tree, and scope them only around that tree's synchronous render
// (`withSessionGenericFamilyOverrides` in `src/render/font-resolution.ts`).
// Static routes remain only as a degraded fallback when probing fails or is
// explicitly disabled.

import type { BrowserContext, CDPSession, Frame, Page } from "@playwright/test";
import type { CapturedSessionGenericFamilies } from "./types.js";
import { localeToScriptCodeForFontSelection } from "../render/generic-script-families.js";

/** Browser settings families that participate in Blink's declared-family
 *  list. `standard` is the implicit final family and therefore also owns the
 *  `.notdef` donor when every declared candidate is exhausted. */
const PROBED_GENERICS = ["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"] as const;
const SCRIPT_PROBE_TEXT: Readonly<Record<string, string>> = {
  KATAKANA_OR_HIRAGANA: "日",
  HANGUL: "한",
  SIMPLIFIED_HAN: "汉",
  TRADITIONAL_HAN: "漢",
  CYRILLIC: "Я",
  ARABIC: "ا",
  GREEK: "Ω",
  LATIN: "A",
  HEBREW: "א",
  DEVANAGARI: "अ",
  THAI: "ก",
  GEORGIAN: "ა",
};
const scriptProbeText = (lang: string): string =>
  SCRIPT_PROBE_TEXT[localeToScriptCodeForFontSelection(lang)] ?? "A";
const SCRIPT_PROBES = [
  { lang: "ja", text: "日" },
  { lang: "ko", text: "한" },
  { lang: "zh-Hans", text: "汉" },
  { lang: "zh-Hant", text: "漢" },
  { lang: "ru", text: "Я" },
  { lang: "ar", text: "ا" },
  { lang: "el", text: "Ω" },
  // Full Chrome profile preferences are not limited to Playwright's four
  // macOS/seven Windows table entries. These three are standing controls for
  // ordinary Latin plus two settings scripts absent from Playwright's table;
  // every additional language actually present in the captured page is added
  // dynamically below.
  { lang: "en", text: "A" },
  { lang: "he", text: "א" },
  { lang: "hi", text: "अ" },
] as const;
const SCRIPT_PROBED_GENERICS = PROBED_GENERICS;

export interface SessionGenericFamilyProbe {
  common: ReadonlyMap<string, string>;
  /** UScriptCode name → generic keyword → painted family. */
  byScript: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Select a name that the platform's native family resolver can replay.
 * CoreText accepts exact PostScript members and needs them for dot-prefixed
 * system faces. Fontconfig and DirectWrite consume family display names. */
export function genericFamilyReplayName(
  platform: NodeJS.Platform,
  face: { familyName: string; postScriptName?: string },
): string {
  return platform === "darwin"
    ? face.postScriptName || face.familyName
    : face.familyName;
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

interface DomSnapshotLanguageFacts {
  strings: readonly string[];
  documents: ReadonlyArray<{
    contentLanguage: number;
    nodes: { attributes?: ReadonlyArray<readonly number[]> };
  }>;
}

/**
 * Read Blink's actual language inputs from a flattened DOM snapshot. Unlike a
 * page `querySelectorAll("[lang]")`, DOMSnapshot includes open/closed shadow
 * trees, and its document record exposes the response-header-owned
 * `Document::ContentLanguage()` value used as the last inherited-language
 * fallback (`element.cc`, `ComputeInheritedLanguage`, rev 7d859f27).
 */
export function languagesFromDomSnapshot(snapshot: DomSnapshotLanguageFacts): string[] {
  const languages = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value != null && value.trim() !== "") languages.add(value);
  };
  for (const document of snapshot.documents) {
    add(snapshot.strings[document.contentLanguage]);
    for (const attributes of document.nodes.attributes ?? []) {
      for (let i = 0; i + 1 < attributes.length; i += 2) {
        const name = snapshot.strings[attributes[i]]?.toLowerCase();
        if (name === "lang" || name === "xml:lang") add(snapshot.strings[attributes[i + 1]]);
      }
    }
  }
  return [...languages];
}

async function pageLanguageFacts(cdp: CDPSession): Promise<string[]> {
  // DM-2593: do not also walk `page.frames()` with Playwright evaluations.
  // On a reused page, Chromium can leave evaluation of a freshly navigated
  // `srcdoc` frame unresolved indefinitely. The flattened snapshot is already
  // the stronger authority: it includes every local document plus open and
  // closed shadow trees, while OOPIF Settings are authenticated separately by
  // `assertGenericFamilyTargetConsistency` below.
  return await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includeDOMRects: false,
    includePaintOrder: false,
  }).then(languagesFromDomSnapshot).catch(() => [] as string[]);
}

export function genericFamilyProbeTargets(additionalLanguages: readonly string[] = []): ProbeTarget[] {
  const common = PROBED_GENERICS.map((generic, i) => ({
    id: `gc${i}`, generic, text: "Regna", lang: null, script: null,
  }));
  const scriptedInputs = [...SCRIPT_PROBES, ...additionalLanguages.map((lang) => ({ lang, text: scriptProbeText(lang) }))]
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

// Keep the Inspector session that observes Page-owned font Settings alive for
// the lifetime of its target. On some hosted macOS Chrome builds, attaching and
// immediately detaching a fresh session can expose the constructor/profile
// table on the next capture even though Playwright's primary Page session still
// owns its launch-time `Page.setFontFamilies` overlay. Besides making a
// read-only probe change the state it is meant to observe, that split adjacent
// animation frames between two otherwise equivalent preference records.
// Reusing one observer also avoids 150+ attach/detach transitions per frame.
const targetProbeSessions = new WeakMap<Page | Frame, Promise<CDPSession>>();

async function persistentTargetProbeSession(target: Page | Frame): Promise<CDPSession> {
  const existing = targetProbeSessions.get(target);
  if (existing != null) return await existing;
  const ownerPage = "page" in target ? target.page() : target;
  const pending = (async () => {
    const session = await ownerPage.context().newCDPSession(target);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    return session;
  })();
  targetProbeSessions.set(target, pending);
  ownerPage.once("close", () => {
    if (targetProbeSessions.get(target) !== pending) return;
    targetProbeSessions.delete(target);
    void pending.then((session) => session.detach()).catch(() => {});
  });
  try {
    return await pending;
  } catch (error) {
    if (targetProbeSessions.get(target) === pending) targetProbeSessions.delete(target);
    throw error;
  }
}

function invalidateTargetProbeSession(target: Page | Frame, session: CDPSession): void {
  const pending = targetProbeSessions.get(target);
  if (pending == null) return;
  targetProbeSessions.delete(target);
  void session.detach().catch(() => {});
}

async function waitForGenericSettingsTurn(target: Page | Frame): Promise<void> {
  // `Page.setFontFamilies` reaches the renderer asynchronously. Immediate
  // back-to-back platform-font reads can therefore agree on the pre-update
  // table under load. Cross one rendering turn before the first observation
  // and between confirmations so "stable" means stable across task/paint
  // boundaries, not merely within one CDP dispatch batch.
  await target.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  }));
}

async function readPageGenericFamilies(
  page: Page | Frame,
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
      if (row.lang != null) {
        span.style.setProperty("-webkit-locale", JSON.stringify(row.lang), "important");
      }
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
      // Fontconfig and DirectWrite resolve family display names, not arbitrary
      // painted PostScript identifiers (`LiberationSans`, `ArialMT`). CoreText
      // can reopen exact PostScript members and needs that precision for
      // dot-prefixed system faces.
      const faceName = genericFamilyReplayName(process.platform, primary);
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
    cdp = await persistentTargetProbeSession(page);
    const targets = genericFamilyProbeTargets(await pageLanguageFacts(cdp));
    await waitForGenericSettingsTurn(page);
    const first = await readPageGenericFamilies(page, cdp, targets);
    await waitForGenericSettingsTurn(page);
    const second = await readPageGenericFamilies(page, cdp, targets);
    if (probeResultsEqual(first, second)) return second;
    await waitForGenericSettingsTurn(page);
    const third = await readPageGenericFamilies(page, cdp, targets);
    return probeResultsEqual(second, third) ? third : null;
  } catch {
    if (cdp != null) invalidateTargetProbeSession(page, cdp);
    return null;
  }
}

async function probeFrameGenericFamilies(frame: Frame): Promise<SessionGenericFamilyProbe | null> {
  let cdp: CDPSession | null = null;
  try {
    cdp = await persistentTargetProbeSession(frame);
  } catch (error) {
    // A local child frame shares its parent's renderer target. Only OOPIFs
    // expose a separate Inspector session and can carry divergent Settings.
    if (error instanceof Error && error.message.includes("does not have a separate CDP session")) return null;
    throw error;
  }
  try {
    const languages = await frame.evaluate(() => [...document.querySelectorAll("[lang]")]
      .map((element) => element.getAttribute("lang") ?? "")
      .filter(Boolean));
    const targets = genericFamilyProbeTargets(languages);
    await waitForGenericSettingsTurn(frame);
    const first = await readPageGenericFamilies(frame, cdp, targets);
    await waitForGenericSettingsTurn(frame);
    const second = await readPageGenericFamilies(frame, cdp, targets);
    return probeResultsEqual(first, second) ? second : null;
  } catch (error) {
    invalidateTargetProbeSession(frame, cdp);
    throw error;
  }
}

/** Refuse a tree whose separate renderer targets have different live generic
 * Settings: one captured authority record cannot represent that state. */
export async function assertGenericFamilyTargetConsistency(
  page: Page,
  main: SessionGenericFamilyProbe | null,
): Promise<void> {
  if (main == null) return;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    // Same-process children inherit this Page's Settings. Besides making a
    // redundant probe, asking Playwright for a separate CDP session on a local
    // `srcdoc` frame can remain pending forever after page reuse (DM-2593).
    // Test the owner from the parent world first; only inaccessible children
    // can be OOPIF targets with independent Settings worth authenticating.
    const owner = await frame.frameElement().catch(() => null);
    let parentReadable = false;
    if (owner != null) {
      try {
        parentReadable = await owner.evaluate((element) =>
          element instanceof HTMLIFrameElement && element.contentDocument != null).catch(() => false);
      } finally {
        await owner.dispose();
      }
    }
    if (parentReadable) continue;
    const child = await probeFrameGenericFamilies(frame);
    if (child != null && !probeResultsEqual(main, child)) {
      throw new Error(`Generic-family Settings diverge for frame target ${frame.url() || "<uncommitted>"}; capture requires one non-divergent Page authority.`);
    }
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
