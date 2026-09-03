/**
 * DM-2504 — exact logical oracle for the platform-owned CSS `system-ui` route.
 *
 * This gate owns no screenshots, pixel thresholds, or expected-face table.
 * Browser faces come from CSS.getPlatformFontsForNode; Domotion faces come
 * from the live native route in glyph-helper.ts. Mutations are derived from
 * the current host inventory and must move the selected logical identity.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
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
  resolveSystemUiFontFace,
  type SystemUiFontFace,
} from "../src/render/glyph-helper.js";
import { invalidateFontEnvironmentCaches } from "../src/render/font-resolution.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const require = createRequire(import.meta.url);

export interface SystemUiProbeCase {
  id: string;
  text: string;
  size: number;
  weight: number;
  italic: boolean;
  stretch: number;
}

export interface BrowserSystemUiFace {
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
  isCustomFont: boolean;
}

interface AgreementRow extends SystemUiProbeCase {
  browser: BrowserSystemUiFace;
  domotion: SystemUiFontFace | null;
  identityKind: "postscript" | "family";
  exact: boolean;
}

interface StateReport {
  id: string;
  rendererSystemFamily: string | null;
  rows: AgreementRow[];
  repeatedBrowserRowsStable: boolean;
  genericMapNegativeControlStable: boolean;
  genericMapRequestedFamily: string;
  candidateFamilies: string[];
  exactRows: number;
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
  browserVersions: string[];
  states: StateReport[];
  preferenceMutation: {
    kind: "coretext-style-metric" | "renderer-system-family" | "windows-menu-font";
    before: string;
    after: string;
    active: boolean;
    staleBeforeInvalidation?: string;
    staleCacheRetainedOldPreference?: boolean;
  };
  pass: boolean;
}

interface UnavailableMode {
  id: LaunchMode["id"];
  unavailable: true;
  error: string;
}

export interface SystemUiPreferenceRouteReport {
  schemaVersion: 1;
  ticket: "DM-2504";
  contract: "platform-system-ui-logical-identity-no-pixel-tolerance-no-answer-snapshot";
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

const MODES: LaunchMode[] = [
  { id: "pinned-headless", engine: "playwright-pinned-chromium", headless: true, options: { headless: true } },
  { id: "pinned-headed", engine: "playwright-pinned-chromium", headless: false, options: { headless: false } },
  { id: "full-chrome-headless", engine: "full-chrome-channel", headless: true, options: { channel: "chrome", headless: true } },
  { id: "full-chrome-headed", engine: "full-chrome-channel", headless: false, options: { channel: "chrome", headless: false } },
];

const CASES: SystemUiProbeCase[] = [
  { id: "text-normal", text: "System UI text 0123", size: 13, weight: 400, italic: false, stretch: 100 },
  { id: "display-normal", text: "System UI display 4567", size: 20, weight: 400, italic: false, stretch: 100 },
  { id: "light", text: "System UI light 89", size: 16, weight: 300, italic: false, stretch: 100 },
  { id: "bold", text: "System UI bold 01", size: 16, weight: 700, italic: false, stretch: 100 },
  { id: "italic", text: "System UI italic 23", size: 16, weight: 400, italic: true, stretch: 100 },
  { id: "condensed", text: "System UI narrow 45", size: 16, weight: 400, italic: false, stretch: 75 },
  { id: "expanded", text: "System UI wide 67", size: 16, weight: 400, italic: false, stretch: 125 },
];

const CONTROL_FAMILIES = ["serif", "monospace", "sans-serif"] as const;
let probeSequence = 0;

export function systemUiProbeCases(): SystemUiProbeCase[] {
  return CASES.map((row) => ({ ...row }));
}

export function launchModeIds(): LaunchMode["id"][] {
  return MODES.map((mode) => mode.id);
}

export function selectedLaunchModeIds(args: string[]): LaunchMode["id"][] {
  return selectedModes(args).map((mode) => mode.id);
}

export function logicalIdentity(
  browser: Pick<BrowserSystemUiFace, "postScriptName" | "familyName">,
  domotion: Pick<SystemUiFontFace, "postscriptName" | "familyName"> | null,
): { kind: "postscript" | "family"; browser: string; domotion: string; exact: boolean } {
  const kind = browser.postScriptName != null && browser.postScriptName !== ""
    && domotion?.postscriptName != null && domotion.postscriptName !== ""
    ? "postscript" : "family";
  const browserName = kind === "postscript" ? browser.postScriptName! : browser.familyName;
  const domotionName = kind === "postscript" ? domotion?.postscriptName ?? "" : domotion?.familyName ?? "";
  return {
    kind,
    browser: browserName,
    domotion: domotionName,
    exact: normalizeFace(browserName) === normalizeFace(domotionName),
  };
}

function normalizeFace(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function faceId(face: BrowserSystemUiFace | SystemUiFontFace | null): string {
  if (face == null) return "";
  return "postScriptName" in face
    ? face.postScriptName ?? face.familyName
    : face.postscriptName || face.familyName;
}

async function prepareCdp(context: BrowserContext, page: Page): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  return cdp;
}

async function platformFace(cdp: CDPSession, nodeId: number): Promise<BrowserSystemUiFace> {
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const primary = fonts.reduce(
    (best, candidate) => best == null || candidate.glyphCount > best.glyphCount ? candidate : best,
    null as (typeof fonts)[number] | null,
  );
  if (primary == null || primary.familyName === "") throw new Error("browser reported no platform face");
  return {
    familyName: primary.familyName,
    postScriptName: primary.postScriptName || null,
    glyphCount: primary.glyphCount,
    isCustomFont: primary.isCustomFont,
  };
}

async function browserRows(
  page: Page,
  cdp: CDPSession,
): Promise<{ rows: Array<{ target: SystemUiProbeCase; face: BrowserSystemUiFace }>; candidates: BrowserSystemUiFace[] }> {
  const id = `__domotion_dm2504_${++probeSequence}`;
  await page.evaluate(({ containerId, cases, controls }) => {
    const root = document.createElement("div");
    root.id = containerId;
    root.style.cssText = "all:initial;position:fixed;left:-100000px;top:0;width:4000px;height:4000px;contain:strict";
    for (const row of cases) {
      const span = document.createElement("span");
      span.id = `${containerId}_${row.id}`;
      span.style.cssText = `all:initial;display:block;font-family:system-ui;font-size:${row.size}px;font-weight:${row.weight};font-style:${row.italic ? "italic" : "normal"};font-stretch:${row.stretch}%`;
      span.textContent = row.text;
      root.appendChild(span);
    }
    for (const family of controls) {
      const span = document.createElement("span");
      span.id = `${containerId}_control_${family}`;
      span.style.cssText = `all:initial;display:block;font-family:${family};font-size:16px`;
      span.textContent = "Installed candidate 0123";
      root.appendChild(span);
    }
    document.documentElement.appendChild(root);
  }, { containerId: id, cases: CASES, controls: CONTROL_FAMILIES });

  try {
    await page.evaluate(() => document.fonts.ready);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows = [] as Array<{ target: SystemUiProbeCase; face: BrowserSystemUiFace }>;
    for (const target of CASES) {
      const result = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}_${target.id}` });
      if (result.nodeId === 0) throw new Error(`lost system-ui target ${target.id}`);
      rows.push({ target, face: await platformFace(cdp, result.nodeId) });
    }
    const candidates: BrowserSystemUiFace[] = [];
    for (const family of CONTROL_FAMILIES) {
      const result = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}_control_${family}` });
      if (result.nodeId !== 0) candidates.push(await platformFace(cdp, result.nodeId));
    }
    return { rows, candidates };
  } finally {
    await page.evaluate((containerId) => document.getElementById(containerId)?.remove(), id).catch(() => {});
  }
}

function browserRowsStable(
  first: Array<{ target: SystemUiProbeCase; face: BrowserSystemUiFace }>,
  second: Array<{ target: SystemUiProbeCase; face: BrowserSystemUiFace }>,
): boolean {
  return first.length === second.length && first.every((row, index) =>
    row.target.id === second[index].target.id
      && normalizeFace(faceId(row.face)) === normalizeFace(faceId(second[index].face))
      && row.face.glyphCount === second[index].face.glyphCount);
}

async function collectState(
  mode: LaunchMode,
  id: string,
  launchArgs: string[],
  rendererSystemFamily: string | null,
): Promise<{ state: StateReport; browserVersion: string }> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch({
      ...mode.options,
      args: [...(mode.options.args ?? []), ...launchArgs],
    });
    context = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: "en-US" });
    const page = await context.newPage();
    await page.setContent("<!doctype html><meta charset=utf-8><body>DM-2504</body>");
    const cdp = await prepareCdp(context, page);
    const first = await browserRows(page, cdp);
    const second = await browserRows(page, cdp);

    const candidate = second.candidates.find((item) =>
      normalizeFace(item.familyName) !== normalizeFace(second.rows[0].face.familyName))
      ?? second.candidates[0];
    if (candidate == null) throw new Error("no installed family for generic-map negative control");

    const negativePage = await context.newPage();
    const negativeCdp = await context.newCDPSession(negativePage);
    await negativeCdp.send("Page.setFontFamilies", {
      fontFamilies: { standard: candidate.familyName, sansSerif: candidate.familyName },
    });
    await negativePage.setContent("<!doctype html><meta charset=utf-8><body>DM-2504 negative control</body>");
    await negativeCdp.send("DOM.enable");
    await negativeCdp.send("CSS.enable");
    const negative = await browserRows(negativePage, negativeCdp);

    const genericMapNegativeControlStable = browserRowsStable(second.rows, negative.rows);
    const rows: AgreementRow[] = second.rows.map(({ target, face }) => {
      const domotion = resolveSystemUiFontFace({
        size: target.size,
        weight: target.weight,
        italic: target.italic,
        slant: target.italic ? 1 : 0,
        stretch: target.stretch,
      }, rendererSystemFamily ?? undefined);
      const identity = logicalIdentity(face, domotion);
      return { ...target, browser: face, domotion, identityKind: identity.kind, exact: identity.exact };
    });
    const exactRows = rows.filter((row) => row.exact).length;
    const repeatedBrowserRowsStable = browserRowsStable(first.rows, second.rows);
    await Promise.all([cdp.detach(), negativeCdp.detach()]);
    return {
      browserVersion: browser.version(),
      state: {
        id,
        rendererSystemFamily,
        rows,
        repeatedBrowserRowsStable,
        genericMapNegativeControlStable,
        genericMapRequestedFamily: candidate.familyName,
        candidateFamilies: [...new Set(second.candidates.map((item) => item.familyName))],
        exactRows,
        pass: repeatedBrowserRowsStable && genericMapNegativeControlStable && exactRows === rows.length,
      },
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function normalFace(state: StateReport): string {
  const row = state.rows.find((item) => item.id === "display-normal") ?? state.rows[0];
  return faceId(row.browser);
}

async function runDarwinMode(mode: LaunchMode): Promise<ModeReport> {
  invalidateFontEnvironmentCaches();
  const result = await collectState(mode, "coretext-live", [], null);
  const distinct = new Set(result.state.rows.map((row) => normalizeFace(faceId(row.browser))));
  const active = distinct.size >= 3;
  return {
    id: mode.id,
    engine: mode.engine,
    headless: mode.headless,
    browserVersions: [result.browserVersion],
    states: [result.state],
    preferenceMutation: {
      kind: "coretext-style-metric",
      before: faceId(result.state.rows.find((row) => row.id === "text-normal")?.browser ?? null),
      after: faceId(result.state.rows.find((row) => row.id === "bold")?.browser ?? null),
      active,
    },
    pass: result.state.pass && active,
  };
}

interface FontconfigMatch { query: string; family: string; postscriptName: string; path: string }

function fontconfigMatch(query: string): FontconfigMatch {
  const raw = execFileSync("fc-match", ["--format", "%{family[0]}\n%{postscriptname}\n%{file}\n", query], {
    cwd: ROOT,
    encoding: "utf8",
  }).trimEnd().split("\n");
  if (!raw[0] || !raw[2]) throw new Error(`fontconfig could not resolve ${query}`);
  return { query, family: raw[0], postscriptName: raw[1] ?? "", path: raw[2] };
}

export function chooseLinuxSystemFamilies(matches: FontconfigMatch[]): { baseline: FontconfigMatch; mutation: FontconfigMatch } {
  const baseline = matches[0];
  if (baseline == null) throw new Error("missing baseline fontconfig match");
  const mutation = matches.slice(1).find((candidate) =>
    normalizeFace(candidate.family) !== normalizeFace(baseline.family)
      && normalizeFace(candidate.postscriptName || candidate.path) !== normalizeFace(baseline.postscriptName || baseline.path));
  if (mutation == null) throw new Error("no distinct installed Linux system-family mutation");
  return { baseline, mutation };
}

async function runLinuxMode(mode: LaunchMode): Promise<ModeReport> {
  const families = chooseLinuxSystemFamilies([
    fontconfigMatch("sans"),
    fontconfigMatch("serif"),
    fontconfigMatch("monospace"),
  ]);
  invalidateFontEnvironmentCaches();
  const baseline = await collectState(
    mode,
    "renderer-family-baseline",
    [`--system-font-family=${families.baseline.family}`],
    families.baseline.family,
  );
  invalidateFontEnvironmentCaches();
  const mutation = await collectState(
    mode,
    "renderer-family-mutation",
    [`--system-font-family=${families.mutation.family}`],
    families.mutation.family,
  );
  const before = normalFace(baseline.state);
  const after = normalFace(mutation.state);
  const active = normalizeFace(before) !== normalizeFace(after);
  return {
    id: mode.id,
    engine: mode.engine,
    headless: mode.headless,
    browserVersions: [baseline.browserVersion, mutation.browserVersion],
    states: [baseline.state, mutation.state],
    preferenceMutation: { kind: "renderer-system-family", before, after, active },
    pass: baseline.state.pass && mutation.state.pass && active,
  };
}

interface WindowsMenuMetric { menuFamily: string; messageFamily: string; menuHeight: number }

function windowsMenuMetric(mode: "get" | "set", family?: string): WindowsMenuMetric {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve(ROOT, "tools/windows-menu-font-preference.ps1"), "-Mode", mode];
  if (family != null) args.push("-Family", family);
  const raw = execFileSync("pwsh", args, { cwd: ROOT, encoding: "utf8" }).trim();
  return JSON.parse(raw) as WindowsMenuMetric;
}

function chooseWindowsMutationFamily(state: StateReport, current: string): string {
  const candidate = state.candidateFamilies.find((family) =>
    normalizeFace(family) !== normalizeFace(current) && family.length < 32);
  if (candidate == null) throw new Error("no distinct installed Windows menu-font mutation");
  return candidate;
}

async function runWindowsMode(mode: LaunchMode, allowMutation: boolean): Promise<ModeReport> {
  if (!allowMutation) throw new Error("Windows requires --allow-system-preference-mutation (the tool restores the original metric in finally)");
  const original = windowsMenuMetric("get");
  let mutated = false;
  try {
    invalidateFontEnvironmentCaches();
    const baseline = await collectState(mode, "menu-font-baseline", [], null);
    const alternative = chooseWindowsMutationFamily(baseline.state, original.menuFamily);
    const warmBefore = resolveSystemUiFontFace({ size: 20, weight: 400 });
    const observedMutation = windowsMenuMetric("set", alternative);
    mutated = true;
    if (normalizeFace(observedMutation.menuFamily) !== normalizeFace(alternative)) {
      throw new Error(`Windows menu-font mutation was inert: requested ${alternative}, observed ${observedMutation.menuFamily}`);
    }
    const stale = resolveSystemUiFontFace({ size: 20, weight: 400 });
    invalidateFontEnvironmentCaches();
    const mutation = await collectState(mode, "menu-font-mutation", [], null);
    const before = normalFace(baseline.state);
    const after = normalFace(mutation.state);
    const active = normalizeFace(before) !== normalizeFace(after);
    const staleCacheRetainedOldPreference = normalizeFace(stale?.systemFamily ?? "")
      === normalizeFace(warmBefore?.systemFamily ?? "")
      && normalizeFace(stale?.systemFamily ?? "") !== normalizeFace(observedMutation.menuFamily);
    return {
      id: mode.id,
      engine: mode.engine,
      headless: mode.headless,
      browserVersions: [baseline.browserVersion, mutation.browserVersion],
      states: [baseline.state, mutation.state],
      preferenceMutation: {
        kind: "windows-menu-font",
        before,
        after,
        active,
        staleBeforeInvalidation: stale?.systemFamily ?? "",
        staleCacheRetainedOldPreference,
      },
      pass: baseline.state.pass && mutation.state.pass && active && staleCacheRetainedOldPreference,
    };
  } finally {
    if (mutated) windowsMenuMetric("set", original.menuFamily);
    invalidateFontEnvironmentCaches();
  }
}

async function runMode(mode: LaunchMode, args: string[]): Promise<ModeReport> {
  if (platform() === "darwin") return runDarwinMode(mode);
  if (platform() === "linux") return runLinuxMode(mode);
  if (platform() === "win32") return runWindowsMode(mode, args.includes("--allow-system-preference-mutation"));
  throw new Error(`unsupported platform ${platform()}`);
}

function revision(repo: string, ref = "HEAD"): string {
  try {
    return execFileSync("git", ["-C", resolve(ROOT, repo), "rev-parse", "--short=12", ref], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function fontInventory(): SystemUiPreferenceRouteReport["environment"]["fontInventory"] {
  const raw = execFileSync(process.execPath, [resolve(ROOT, "tools/font-inventory.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as SystemUiPreferenceRouteReport["environment"]["fontInventory"] & { entries?: string[] };
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

export async function runSystemUiPreferenceRouteOracle(
  args: string[] = process.argv.slice(2),
): Promise<SystemUiPreferenceRouteReport> {
  const modes = selectedModes(args);
  const reports: Array<ModeReport | UnavailableMode> = [];
  for (const mode of modes) {
    process.stderr.write(`[DM-2504] ${mode.id}\n`);
    try {
      reports.push(await runMode(mode, args));
    } catch (error) {
      reports.push({ id: mode.id, unavailable: true, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const available = reports.filter((report): report is ModeReport => !("unavailable" in report));
  const unavailable = reports.filter((report): report is UnavailableMode => "unavailable" in report);
  const exactRows = available.reduce((sum, mode) =>
    sum + mode.states.reduce((stateSum, state) => stateSum + state.exactRows, 0), 0);
  const totalRows = available.reduce((sum, mode) =>
    sum + mode.states.reduce((stateSum, state) => stateSum + state.rows.length, 0), 0);
  const verdict = unavailable.length > 0 || available.length === 0
    ? "unavailable"
    : available.every((mode) => mode.pass) ? "source-exact" : "source-drift";
  return {
    schemaVersion: 1,
    ticket: "DM-2504",
    contract: "platform-system-ui-logical-identity-no-pixel-tolerance-no-answer-snapshot",
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
  const report = await runSystemUiPreferenceRouteOracle(args);
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
