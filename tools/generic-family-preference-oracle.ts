/**
 * DM-2351 — logical generic-family preference oracle.
 *
 * This gate compares face identity only. It deliberately takes no screenshots
 * and owns no pixel tolerance: first prove which concrete face Blink selected
 * under the live page's settings, then ask Domotion's resolver the identical
 * generic/language question.
 *
 * Matrix:
 *   - Playwright's pinned Chromium: headless + headed
 *   - installed full Chrome channel: headless + headed
 *   - each launch shape: observed default + every non-inert controlled
 *     Page.setFontFamilies mutation supported by that run's own
 *     installed/painted faces
 *   - Common + ja/ko/zh-Hans/zh-Hant/ru/ar/el settings scripts
 *   - standard/serif/sans-serif/monospace/cursive/fantasy/math
 *   - system-ui as the settings-map separation control and quoted `"serif"`
 *     as the generic-keyword classification control
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type LaunchOptions,
  type Page,
} from "@playwright/test";
import {
  ensureSessionGenericFamilyOverrides,
  genericFamilyReplayName,
  genericFamilyProbeTargets,
  type SessionGenericFamilyProbe,
} from "../src/capture/generic-font-probe.js";
import {
  getFontInstance,
  getSessionGenericFamilyOverrides,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  setSessionGenericFamilyOverrides,
  withSessionGenericFamilyOverrides,
} from "../src/render/font-resolution.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const require = createRequire(import.meta.url);

type SettingsGenericName = "standard" | "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "math";
type GenericName = SettingsGenericName | "system-ui" | "quoted-serif";
type ProtocolFamilyKey = "standard" | "fixed" | "serif" | "sansSerif" | "cursive" | "fantasy" | "math";
type FontFamilies = Partial<Record<ProtocolFamilyKey, string>>;
type ScriptFontFamilies = { script: string; fontFamilies: FontFamilies };

export interface LogicalProbeTarget {
  id: string;
  generic: GenericName;
  text: string;
  lang: string | null;
  script: string | null;
}

export interface BlinkPreferenceRow extends LogicalProbeTarget {
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface PreferenceMutationPlan {
  fontFamilies: FontFamilies;
  forScripts: ScriptFontFamilies[];
  /** Scripts whose observed defaults expose no second paint-capable face. */
  unavailableScripts: string[];
  /** target id -> face identity expected after applying the family request. */
  expectedFaceByTarget: Record<string, string>;
}

interface LogicalAgreementRow extends BlinkPreferenceRow {
  domotionFace: string | null;
  exact: boolean;
}

interface PreferenceStateReport {
  kind: "default" | "mutation";
  requestedPreferences: {
    fontFamilies: FontFamilies;
    forScripts: ScriptFontFamilies[];
    unavailableScripts: string[];
  } | null;
  observedPreferences: {
    common: Record<string, string>;
    byScript: Record<string, Record<string, string>>;
  };
  productionProbeMatchesIndependentRows: boolean;
  productionProbeLeftPriorGlobalUntouched: boolean;
  repeatStable: boolean;
  rows: LogicalAgreementRow[];
  exactRows: number;
  mismatches: number;
  expectedMutationRows: number | null;
  expectedMutationMatches: number | null;
  pass: boolean;
}

interface LaunchMode {
  id: "pinned-headless" | "pinned-headed" | "full-chrome-headless" | "full-chrome-headed";
  engine: "playwright-pinned-chromium" | "full-chrome-channel";
  headless: boolean;
  options: LaunchOptions;
}

interface ModeReport {
  id: LaunchMode["id"];
  engine: LaunchMode["engine"];
  headless: boolean;
  browserVersion: string;
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
  jsVersion: string;
  navigator: { userAgent: string; language: string; languages: string[]; platform: string };
  default: PreferenceStateReport;
  mutation: PreferenceStateReport;
  mutatedGenericRows: number;
  systemUiNegativeControlRows: number;
  systemUiNegativeControlStable: boolean;
  quotedLiteralControlRows: number;
  quotedLiteralControlExact: boolean;
  legacyProcessGlobalContaminatedRows: number;
  capturedScopeRecoveredRows: number;
  capturedScopeRestoredPriorGlobal: boolean;
  pass: boolean;
}

interface UnavailableMode {
  id: LaunchMode["id"];
  unavailable: true;
  error: string;
}

export interface GenericFamilyPreferenceReport {
  schemaVersion: 1;
  ticket: "DM-2351";
  contract: "logical-face-identity-no-pixel-tolerance";
  environment: {
    platform: NodeJS.Platform;
    release: string;
    architecture: string;
    node: string;
    playwright: string;
    locale: string;
    lang: string;
    fontInventory: { platform: string; arch: string; source: string; count: number; digest: string };
    sources: { chromium: string; skia: string; harfbuzz: string };
  };
  requiredModes: LaunchMode["id"][];
  modes: Array<ModeReport | UnavailableMode>;
  exactRows: number;
  totalRows: number;
  unavailableModes: number;
  verdict: "source-exact" | "source-drift" | "unavailable";
}

const SCRIPT_PROTOCOL_NAMES: Readonly<Record<string, string>> = {
  KATAKANA_OR_HIRAGANA: "jpan",
  HANGUL: "hang",
  SIMPLIFIED_HAN: "hans",
  TRADITIONAL_HAN: "hant",
  CYRILLIC: "cyrl",
  ARABIC: "arab",
  GREEK: "grek",
  LATIN: "latn",
  HEBREW: "hebr",
  DEVANAGARI: "deva",
};

const PROTOCOL_KEYS: Readonly<Record<SettingsGenericName, ProtocolFamilyKey>> = {
  standard: "standard",
  serif: "serif",
  "sans-serif": "sansSerif",
  monospace: "fixed",
  cursive: "cursive",
  fantasy: "fantasy",
  math: "math",
};

const MODES: LaunchMode[] = [
  { id: "pinned-headless", engine: "playwright-pinned-chromium", headless: true, options: { headless: true } },
  { id: "pinned-headed", engine: "playwright-pinned-chromium", headless: false, options: { headless: false } },
  { id: "full-chrome-headless", engine: "full-chrome-channel", headless: true, options: { channel: "chrome", headless: true } },
  { id: "full-chrome-headed", engine: "full-chrome-channel", headless: false, options: { channel: "chrome", headless: false } },
];

let probeSequence = 0;
const face = (row: BlinkPreferenceRow): string => row.postScriptName ?? row.familyName;
export const settingsPreferenceRequestName = (
  hostPlatform: NodeJS.Platform,
  row: Pick<BlinkPreferenceRow, "familyName" | "postScriptName">,
): string => hostPlatform === "darwin" && !/^[\x20-\x7e]+$/.test(row.familyName)
  ? row.postScriptName || row.familyName
  : row.familyName;
const settingsRequestName = (row: BlinkPreferenceRow): string =>
  settingsPreferenceRequestName(process.platform, row);
const normFace = (value: string | null | undefined): string => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const targetKey = (target: Pick<LogicalProbeTarget, "script" | "generic">): string => `${target.script ?? "COMMON"}/${target.generic}`;
const isSettingsGeneric = (generic: GenericName): generic is SettingsGenericName =>
  generic !== "system-ui" && generic !== "quoted-serif";

export function logicalProbeTargets(): LogicalProbeTarget[] {
  const settings = genericFamilyProbeTargets() as LogicalProbeTarget[];
  const systemUi = [
    { id: "gui", generic: "system-ui" as const, text: "Regna", lang: null, script: null },
    ...settings
      .filter((target) => target.generic === "standard" && target.lang != null)
      .map((target, index) => ({
        id: `guis${index}`,
        generic: "system-ui" as const,
        // Keep Page generic-family settings out of this negative control:
        // use a glyph covered by the platform UI face while retaining the
        // locale tag that distinguishes script ownership.
        text: "A",
        lang: target.lang,
        script: target.script,
      })),
  ];
  const quotedSerif = [
    { id: "gqi", generic: "quoted-serif" as const, text: "Regna", lang: null, script: null },
    ...settings
      .filter((target) => target.generic === "standard" && target.lang != null)
      .map((target, index) => ({
        id: `gqis${index}`,
        generic: "quoted-serif" as const,
        text: target.text,
        lang: target.lang,
        script: target.script,
      })),
  ];
  return [...settings, ...systemUi, ...quotedSerif];
}

async function readBlinkPreferenceRows(page: Page, cdp: CDPSession): Promise<BlinkPreferenceRow[]> {
  const targets = logicalProbeTargets();
  const containerId = `__domotion_dm2351_${++probeSequence}`;
  await page.evaluate(({ id, rows }) => {
    const container = document.createElement("div");
    container.id = id;
    container.setAttribute("aria-hidden", "true");
    container.style.cssText = "all:initial;position:fixed;left:-100000px;top:0;display:block;contain:strict;width:4000px;height:4000px;pointer-events:none";
    for (const row of rows) {
      const span = document.createElement("span");
      span.id = `${id}_${row.id}`;
      span.style.cssText = "all:initial;display:block;font-size:32px;line-height:normal";
      if (row.lang != null) span.lang = row.lang;
      // `lang` maps to Blink's inherited -webkit-locale presentation
      // property. `all: initial` above resets it, so restore the same quoted
      // value after neutralization before asking which script preference won.
      if (row.lang != null) span.style.setProperty("-webkit-locale", JSON.stringify(row.lang));
      if (row.generic !== "standard") {
        span.style.fontFamily = row.generic === "quoted-serif" ? '"serif"' : row.generic;
      }
      span.textContent = row.text;
      container.appendChild(span);
    }
    document.documentElement.appendChild(container);
  }, { id: containerId, rows: targets });

  try {
    await page.evaluate(() => document.fonts.ready);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows: BlinkPreferenceRow[] = [];
    for (const target of targets) {
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `#${containerId}_${target.id}`,
      });
      if (nodeId === 0) throw new Error(`independent probe lost ${target.id}`);
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const primary = fonts.reduce(
        (best, candidate) => best == null || candidate.glyphCount > best.glyphCount ? candidate : best,
        null as (typeof fonts)[number] | null,
      );
      if (primary == null || primary.familyName === "") {
        throw new Error(`Blink reported no platform face for ${targetKey(target)}`);
      }
      rows.push({
        ...target,
        familyName: primary.familyName,
        postScriptName: primary.postScriptName || null,
        glyphCount: primary.glyphCount,
        isCustomFont: primary.isCustomFont,
      });
    }
    return rows;
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), containerId).catch(() => {});
  }
}

function rowsStable(a: BlinkPreferenceRow[], b: BlinkPreferenceRow[]): boolean {
  return a.length === b.length && a.every((row, index) =>
    targetKey(row) === targetKey(b[index])
      && normFace(face(row)) === normFace(face(b[index]))
      && row.glyphCount === b[index].glyphCount);
}

function probeMatchesRows(probe: SessionGenericFamilyProbe, rows: BlinkPreferenceRow[]): boolean {
  return rows.filter((row) => isSettingsGeneric(row.generic)).every((row) => {
    const observed = row.script == null
      ? probe.common.get(row.generic)
      : probe.byScript.get(row.script)?.get(row.generic);
    return normFace(observed) === normFace(genericFamilyReplayName(process.platform, row));
  });
}

function observedPreferences(probe: SessionGenericFamilyProbe): PreferenceStateReport["observedPreferences"] {
  return {
    common: Object.fromEntries(probe.common),
    byScript: Object.fromEntries(
      [...probe.byScript].map(([script, families]) => [script, Object.fromEntries(families)]),
    ),
  };
}

function domotionRows(
  sourceRows: BlinkPreferenceRow[],
  probe: SessionGenericFamilyProbe,
): LogicalAgreementRow[] {
  return withSessionGenericFamilyOverrides(probe, () => sourceRows.map((row) => {
    const domotionFace = resolveDomotionPaintedFace(row);
    return { ...row, domotionFace, exact: normFace(domotionFace) === normFace(face(row)) };
  }));
}

/** Resolve the face that paints the row's scalar, not merely its declared
 * primary. This distinction is load-bearing for protected macOS faces: Blink
 * rejects a dot-prefixed family as a direct setting, then reaches it from the
 * Common primary through CTFontCreateForString at the fallback stage. */
function resolveDomotionPaintedFace(row: BlinkPreferenceRow): string | null {
  const family = row.generic === "standard"
    ? "__domotion_dm2351_missing_family__"
    : row.generic === "quoted-serif" ? '"serif"' : row.generic;
  const lang = row.lang ?? undefined;
  const primaryKey = resolveFontKey(family, lang);
  const primary = resolveFont(family, 400, 32, 0, undefined, 100, lang);
  const cp = row.text.codePointAt(0);
  if (primary == null || cp == null) return null;
  const painted = resolveFontForCodepoint(
    cp,
    primary,
    primaryKey,
    400,
    32,
    0,
    undefined,
    lang,
    resolveFontKeyChain(family, lang),
    row.generic === "system-ui",
    100,
    undefined,
    family,
  );
  const instance = painted.fontOverride ?? getFontInstance(painted.key, 400, 32, 0);
  return instance?.instantiatedPostscriptName
    ?? instance?.postscriptName
    ?? resolveFontSpec(painted.key)?.postscriptName
    ?? null;
}

/** Build mutations only from faces this exact browser/host just painted.
 * There is intentionally no committed OS preference table in this oracle. */
export function buildPreferenceMutation(defaultRows: BlinkPreferenceRow[]): PreferenceMutationPlan {
  const candidatesFor = (rows: BlinkPreferenceRow[], owner: string): BlinkPreferenceRow[] => {
    const candidates = rows.filter((row, index) => rows.findIndex((candidate) =>
      normFace(face(candidate)) === normFace(face(row))) === index);
    if (candidates.length < 2) {
      throw new Error(`controlled mutation needs at least two distinct faces proven to paint ${owner}`);
    }
    return candidates;
  };
  const choose = (row: BlinkPreferenceRow, candidates: BlinkPreferenceRow[]): BlinkPreferenceRow => {
    const candidate = candidates.find((item) => normFace(face(item)) !== normFace(face(row)));
    if (candidate == null) throw new Error(`no distinct installed mutation face for ${targetKey(row)}`);
    return candidate;
  };

  const expectedFaceByTarget: Record<string, string> = {};
  const common: FontFamilies = {};
  const commonRows = defaultRows.filter((item) => item.script == null && isSettingsGeneric(item.generic));
  const commonCandidates = candidatesFor(commonRows, "COMMON");
  for (const row of commonRows) {
    const selected = choose(row, commonCandidates);
    common[PROTOCOL_KEYS[row.generic as SettingsGenericName]] = settingsRequestName(selected);
    expectedFaceByTarget[targetKey(row)] = face(selected);
  }

  const scriptGroups = new Map<string, BlinkPreferenceRow[]>();
  for (const row of defaultRows.filter((item) => item.script != null && isSettingsGeneric(item.generic))) {
    let group = scriptGroups.get(row.script!);
    if (group == null) {
      group = [];
      scriptGroups.set(row.script!, group);
    }
    group.push(row);
  }
  const forScripts: ScriptFontFamilies[] = [];
  const unavailableScripts: string[] = [];
  for (const [script, rows] of scriptGroups) {
    const protocolScript = SCRIPT_PROTOCOL_NAMES[script];
    if (protocolScript == null) throw new Error(`missing protocol script spelling for ${script}`);
    // A Common face may not cover this script's sample and would leave the
    // requested Settings mutation inert after fallback. Only select among
    // faces Blink has just proved can paint this exact script probe.
    const distinctFaces = new Set(rows.map((row) => normFace(face(row))));
    // A stock runner can legitimately expose only one face for a script (for
    // example Devanagari on Windows or Japanese on a minimal Linux image).
    // Its DEFAULT route is still graded exactly above; what cannot honestly be
    // claimed is a non-inert preference mutation. Omit that script from the
    // mutation envelope instead of making the whole four-launch oracle
    // permanently unavailable for lack of a second installed face.
    if (distinctFaces.size < 2) {
      unavailableScripts.push(script);
      continue;
    }
    const scriptCandidates = candidatesFor(rows, script);
    const fontFamilies: FontFamilies = {};
    for (const row of rows) {
      const selected = choose(row, scriptCandidates);
      // Localized display family names (for example PingFang's macOS name)
      // need not be accepted as a Settings lookup string; use the concrete
      // authenticated PostScript identity for those names only. Ordinary
      // family names preserve Blink's family-name lookup path.
      fontFamilies[PROTOCOL_KEYS[row.generic as SettingsGenericName]] = settingsRequestName(selected);
      expectedFaceByTarget[targetKey(row)] = face(selected);
    }
    forScripts.push({ script: protocolScript, fontFamilies });
  }
  return { fontFamilies: common, forScripts, unavailableScripts, expectedFaceByTarget };
}

async function collectState(
  page: Page,
  cdp: CDPSession,
  kind: PreferenceStateReport["kind"],
  mutation: PreferenceMutationPlan | null,
): Promise<{ report: PreferenceStateReport; probe: SessionGenericFamilyProbe; sourceRows: BlinkPreferenceRow[] }> {
  const first = await readBlinkPreferenceRows(page, cdp);
  const second = await readBlinkPreferenceRows(page, cdp);

  const prior = getSessionGenericFamilyOverrides();
  const sentinel: SessionGenericFamilyProbe = {
    common: new Map([["serif", "__dm2351_global_sentinel__"]]),
    byScript: new Map(),
  };
  setSessionGenericFamilyOverrides(sentinel);
  const productionProbe = await ensureSessionGenericFamilyOverrides(page);
  const globalUntouched = getSessionGenericFamilyOverrides() === sentinel;
  setSessionGenericFamilyOverrides(prior);
  if (productionProbe == null) throw new Error(`${kind}: production page probe did not stabilize`);

  const rows = domotionRows(second, productionProbe);
  const expectedMutationRows = mutation == null ? null : Object.keys(mutation.expectedFaceByTarget).length;
  const expectedMutationMatches = mutation == null ? null : second
    .filter((row) => isSettingsGeneric(row.generic))
    .filter((row) => normFace(face(row)) === normFace(mutation.expectedFaceByTarget[targetKey(row)]))
    .length;
  // `system-ui` is owned by the separate platform route, not Page's generic
  // preference maps. Keep those rows in the report as mandatory stability
  // controls, but never grade their face identity as generic-map parity.
  const gradedRows = rows.filter((row) => row.generic !== "system-ui");
  const exactRows = gradedRows.filter((row) => row.exact).length;
  const productionMatches = probeMatchesRows(productionProbe, second);
  const repeatStable = rowsStable(first, second);
  const pass = repeatStable
    && globalUntouched
    && productionMatches
    && exactRows === gradedRows.length
    && (expectedMutationRows == null || expectedMutationMatches === expectedMutationRows);
  return {
    sourceRows: second,
    probe: productionProbe,
    report: {
      kind,
      requestedPreferences: mutation == null
        ? null
        : {
            fontFamilies: mutation.fontFamilies,
            forScripts: mutation.forScripts,
            unavailableScripts: mutation.unavailableScripts,
          },
      observedPreferences: observedPreferences(productionProbe),
      productionProbeMatchesIndependentRows: productionMatches,
      productionProbeLeftPriorGlobalUntouched: globalUntouched,
      repeatStable,
      rows,
      exactRows,
      mismatches: gradedRows.length - exactRows,
      expectedMutationRows,
      expectedMutationMatches,
      pass,
    },
  };
}

function rowsByKey(rows: BlinkPreferenceRow[]): Map<string, BlinkPreferenceRow> {
  return new Map(rows.map((row) => [targetKey(row), row]));
}

function resolveAgainstCurrentGlobal(rows: BlinkPreferenceRow[]): number {
  let exact = 0;
  for (const row of rows) {
    const name = resolveDomotionPaintedFace(row);
    if (normFace(name) === normFace(face(row))) exact++;
  }
  return exact;
}

async function runMode(mode: LaunchMode): Promise<ModeReport> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let mutationSession: CDPSession | null = null;
  try {
    browser = await chromium.launch(mode.options);
    context = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: "en-US" });
    const browserCdp = await browser.newBrowserCDPSession();
    const browserVersion = await browserCdp.send("Browser.getVersion");
    await browserCdp.detach();

    const defaultPage = await context.newPage();
    await defaultPage.setContent("<!doctype html><meta charset=utf-8><body>DM-2351 default</body>");
    const defaultCdp = await context.newCDPSession(defaultPage);
    await defaultCdp.send("DOM.enable");
    await defaultCdp.send("CSS.enable");
    const defaultState = await collectState(defaultPage, defaultCdp, "default", null);

    const mutation = buildPreferenceMutation(defaultState.sourceRows);
    const mutationPage = await context.newPage();
    mutationSession = await context.newCDPSession(mutationPage);
    await mutationSession.send("Page.setFontFamilies", {
      fontFamilies: mutation.fontFamilies,
      forScripts: mutation.forScripts,
    });
    await mutationPage.setContent("<!doctype html><meta charset=utf-8><body>DM-2351 mutation</body>");
    const mutationCdp = await context.newCDPSession(mutationPage);
    await mutationCdp.send("DOM.enable");
    await mutationCdp.send("CSS.enable");
    const mutationState = await collectState(mutationPage, mutationCdp, "mutation", mutation);

    const defaultMap = rowsByKey(defaultState.sourceRows);
    const mutationMap = rowsByKey(mutationState.sourceRows);
    const genericKeys = [...defaultMap].filter(([, row]) => isSettingsGeneric(row.generic)).map(([key]) => key);
    const systemUiKeys = [...defaultMap].filter(([, row]) => row.generic === "system-ui").map(([key]) => key);
    const quotedLiteralKeys = [...defaultMap].filter(([, row]) => row.generic === "quoted-serif").map(([key]) => key);
    const mutatedGenericRows = genericKeys.filter((key) =>
      normFace(face(defaultMap.get(key)!)) !== normFace(face(mutationMap.get(key)!))).length;
    const systemUiNegativeControlStable = systemUiKeys.every((key) =>
      normFace(face(defaultMap.get(key)!)) === normFace(face(mutationMap.get(key)!)));
    const quotedLiteralControlExact = mutationState.report.rows
      .filter((row) => row.generic === "quoted-serif")
      .every((row) => row.exact);

    // Deterministic discriminator for the retired ownership: if state B is
    // installed process-globally, resolving A reads B. The scoped callback
    // recovers A and restores B afterward. Production capture no longer calls
    // this setter; captured trees carry A/B explicitly.
    const prior = getSessionGenericFamilyOverrides();
    const scopedRows = defaultState.sourceRows.filter((row) => isSettingsGeneric(row.generic));
    setSessionGenericFamilyOverrides(mutationState.probe);
    const contaminatedExact = resolveAgainstCurrentGlobal(scopedRows);
    const scopedExact = withSessionGenericFamilyOverrides(
      defaultState.probe,
      () => resolveAgainstCurrentGlobal(scopedRows),
    );
    const restored = getSessionGenericFamilyOverrides() === mutationState.probe;
    setSessionGenericFamilyOverrides(prior);
    const legacyProcessGlobalContaminatedRows = scopedRows.length - contaminatedExact;

    const navigator = await mutationPage.evaluate(() => ({
      userAgent: globalThis.navigator.userAgent,
      language: globalThis.navigator.language,
      languages: [...globalThis.navigator.languages],
      platform: globalThis.navigator.platform,
    }));
    await Promise.all([defaultCdp.detach(), mutationCdp.detach()]);
    const mutationTargetCount = Object.keys(mutation.expectedFaceByTarget).length;
    const pass = defaultState.report.pass
      && mutationState.report.pass
      && mutatedGenericRows === mutationTargetCount
      && systemUiNegativeControlStable
      && quotedLiteralControlExact
      && legacyProcessGlobalContaminatedRows > 0
      && scopedExact === scopedRows.length
      && restored;
    return {
      id: mode.id,
      engine: mode.engine,
      headless: mode.headless,
      browserVersion: browser.version(),
      protocolVersion: browserVersion.protocolVersion,
      product: browserVersion.product,
      revision: browserVersion.revision,
      userAgent: browserVersion.userAgent,
      jsVersion: browserVersion.jsVersion,
      navigator,
      default: defaultState.report,
      mutation: mutationState.report,
      mutatedGenericRows,
      systemUiNegativeControlRows: systemUiKeys.length,
      systemUiNegativeControlStable,
      quotedLiteralControlRows: quotedLiteralKeys.length,
      quotedLiteralControlExact,
      legacyProcessGlobalContaminatedRows,
      capturedScopeRecoveredRows: scopedExact,
      capturedScopeRestoredPriorGlobal: restored,
      pass,
    };
  } finally {
    await mutationSession?.detach().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function revision(repo: string, ref = "HEAD"): string {
  try {
    return execFileSync("git", ["-C", resolve(ROOT, repo), "rev-parse", "--short=12", ref], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function fontInventory(): GenericFamilyPreferenceReport["environment"]["fontInventory"] {
  const raw = execFileSync(process.execPath, [resolve(ROOT, "tools/font-inventory.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as GenericFamilyPreferenceReport["environment"]["fontInventory"] & { entries?: string[] };
  return {
    platform: parsed.platform,
    arch: parsed.arch,
    source: parsed.source,
    count: parsed.count,
    digest: parsed.digest,
  };
}

function selectedModes(args: string[]): LaunchMode[] {
  const value = args.find((arg) => arg.startsWith("--modes="))?.slice("--modes=".length);
  const allowHeaded = args.includes("--allow-headed-browser");
  if (value == null || value === "") return allowHeaded ? MODES : MODES.filter((mode) => mode.headless);
  const ids = new Set(value.split(","));
  const selected = MODES.filter((mode) => ids.has(mode.id));
  const unknown = [...ids].filter((id) => !MODES.some((mode) => mode.id === id));
  if (unknown.length > 0) throw new Error(`unknown modes: ${unknown.join(", ")}`);
  const headed = selected.filter((mode) => !mode.headless);
  if (headed.length > 0 && !allowHeaded) {
    throw new Error(
      `headed browser modes require --allow-headed-browser: ${headed.map((mode) => mode.id).join(", ")}`,
    );
  }
  return selected;
}

export function selectedLaunchModeIds(args: string[]): LaunchMode["id"][] {
  return selectedModes(args).map((mode) => mode.id);
}

export async function runGenericFamilyPreferenceOracle(
  args: string[] = process.argv.slice(2),
): Promise<GenericFamilyPreferenceReport> {
  const modes = selectedModes(args);
  const allowMissingFullChrome = args.includes("--allow-missing-full-chrome");
  const reports: Array<ModeReport | UnavailableMode> = [];
  for (const mode of modes) {
    process.stderr.write(`[DM-2351] ${mode.id}\n`);
    try {
      reports.push(await runMode(mode));
    } catch (error) {
      reports.push({ id: mode.id, unavailable: true, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const available = reports.filter((report): report is ModeReport => !("unavailable" in report));
  const unavailable = reports.filter((report): report is UnavailableMode => "unavailable" in report);
  const missingRequired = unavailable.filter((report) =>
    !allowMissingFullChrome || !report.id.startsWith("full-chrome-"));
  const exactRows = available.reduce((sum, mode) => sum + mode.default.exactRows + mode.mutation.exactRows, 0);
  const totalRows = available.reduce((sum, mode) => sum + mode.default.rows.length + mode.mutation.rows.length, 0);
  const allAvailablePass = available.length > 0 && available.every((mode) => mode.pass);
  const verdict = missingRequired.length > 0 || available.length === 0
    ? "unavailable"
    : allAvailablePass ? "source-exact" : "source-drift";
  return {
    schemaVersion: 1,
    ticket: "DM-2351",
    contract: "logical-face-identity-no-pixel-tolerance",
    environment: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
      playwright: (require("@playwright/test/package.json") as { version: string }).version,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      lang: process.env.LANG ?? "unset",
      fontInventory: fontInventory(),
      sources: {
        chromium: revision("external/chromium"),
        skia: revision("external/skia", "62efacd3"),
        harfbuzz: revision("external/harfbuzz"),
      },
    },
    requiredModes: modes.map((mode) => mode.id),
    modes: reports,
    exactRows,
    totalRows,
    unavailableModes: unavailable.length,
    verdict,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const report = await runGenericFamilyPreferenceOracle(args);
  const outIndex = args.indexOf("--json");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out != null && out !== "") writeFileSync(resolve(out), json);
  process.stdout.write(json);
  process.exitCode = report.verdict === "source-exact" ? 0 : 1;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
