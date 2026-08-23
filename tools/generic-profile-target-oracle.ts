/**
 * Logical Chrome profile -> WebPreferences -> Blink Settings oracle.
 *
 * No pixels are captured. Every requested family is selected from faces painted
 * by this exact browser/font inventory, then written to an isolated profile.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { arch, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Frame, type Page } from "@playwright/test";
import { ensureSessionGenericFamilyOverrides } from "../src/capture/generic-font-probe.js";

const GENERICS = ["standard", "fixed", "serif", "sansserif", "cursive", "fantasy", "math"] as const;
const SCRIPTS = ["Zyyy", "Jpan", "Deva"] as const;
type Generic = typeof GENERICS[number];
type Script = typeof SCRIPTS[number];
type FamilyMap = Record<Generic, string>;
export type ProfileFonts = Record<Generic, Record<Script, string>>;

export interface ProfileFaceRow {
  script: Script;
  generic: Generic;
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface ProfileModeReport {
  mode: "headed" | "headless";
  rows: ProfileFaceRow[];
  expectedRows: number;
  exactRows: number;
  productionProbeExact: boolean;
  pass: boolean;
}

export interface GenericProfileTargetReport {
  schemaVersion: 1;
  contract: "logical-profile-and-target-authority-no-pixels";
  environment: Record<string, unknown>;
  requestedProfile: ProfileFonts;
  cleanHeadless: ProfileFaceRow[];
  headed: ProfileModeReport;
  headless: ProfileModeReport;
  overlay: { headlessMatchesClean: number; profileDiscriminators: number; profileMapRetainedInHeadless: number; pass: boolean };
  target: {
    ordinaryMainFrameExact: boolean;
    ordinaryChildFrameExact: boolean;
    divergentMutationMovedChild: boolean;
    divergentMutationLeftMainStable: boolean;
    supportedContract: "non-divergent-target-settings-only";
    pass: boolean;
  };
  verdict: "source-exact" | "source-drift" | "unavailable";
  errors: string[];
}

const cssGeneric = (generic: Generic): string => generic === "standard" ? "initial" : generic === "fixed" ? "monospace" : generic === "sansserif" ? "sans-serif" : generic;
const language = (script: Script): string | null => script === "Jpan" ? "ja" : script === "Deva" ? "hi" : null;
const key = (row: Pick<ProfileFaceRow, "script" | "generic">): string => `${row.script}/${row.generic}`;
const face = (row: ProfileFaceRow): string => row.postScriptName ?? row.familyName;
const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

async function readRows(owner: Page | Frame, cdp: CDPSession): Promise<ProfileFaceRow[]> {
  const id = `__domotion_profile_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await owner.evaluate(({ id, generics, scripts }) => {
    const root = document.createElement("div");
    root.id = id;
    root.style.cssText = "all:initial;position:absolute;left:0;top:0;display:block;pointer-events:none";
    for (const script of scripts) for (const generic of generics) {
      const span = document.createElement("span");
      span.id = `${id}_${script}_${generic}`;
      span.style.cssText = "all:initial;display:block;font-size:32px;line-height:normal";
      if (generic !== "standard") span.style.fontFamily = generic === "fixed" ? "monospace" : generic === "sansserif" ? "sans-serif" : generic;
      if (script === "Jpan") span.lang = "ja";
      if (script === "Deva") span.lang = "hi";
      span.textContent = script === "Jpan" ? "日" : script === "Deva" ? "अ" : "A";
      root.appendChild(span);
    }
    document.documentElement.appendChild(root);
  }, { id, generics: GENERICS, scripts: SCRIPTS });
  await owner.evaluate(() => new Promise<void>((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint()))));
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows: ProfileFaceRow[] = [];
    for (const script of SCRIPTS) for (const generic of GENERICS) {
      const found = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}_${script}_${generic}` });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: found.nodeId });
      const painted = fonts.reduce((best, item) => best == null || item.glyphCount > best.glyphCount ? item : best, null as typeof fonts[number] | null);
      if (painted == null) throw new Error(`no painted face for ${script}/${generic}`);
      rows.push({ script, generic, familyName: painted.familyName, postScriptName: painted.postScriptName || null, glyphCount: painted.glyphCount, isCustomFont: painted.isCustomFont });
    }
    return rows;
  } finally {
    await owner.evaluate((probeId) => document.getElementById(probeId)?.remove(), id).catch(() => {});
  }
}

const profileFieldSupported = (script: Script, generic: Generic): boolean =>
  script === "Zyyy" || (generic === "standard" || generic === "fixed" || generic === "serif" || generic === "sansserif");

function rotatedProfile(discovery: ProfileFaceRow[], cleanHeadless: ProfileFaceRow[]): ProfileFonts {
  const result = Object.fromEntries(GENERICS.map((generic) => [generic, {}])) as ProfileFonts;
  for (const script of SCRIPTS) {
    const rows = discovery.filter((row) => row.script === script);
    const clean = cleanHeadless.filter((row) => row.script === script);
    const distinct = rows.filter((row, index) => rows.findIndex((other) => norm(other.familyName) === norm(row.familyName)) === index);
    if (distinct.length < 2) throw new Error(`profile discriminator needs two painted ${script} families`);
    for (const generic of GENERICS) {
      const cleanFamily = clean.find((row) => row.generic === generic)!.familyName;
      const discriminator = distinct.find((row) => norm(row.familyName) !== norm(cleanFamily));
      if (discriminator == null) throw new Error(`profile discriminator matches clean ${script}/${generic}`);
      result[generic][script] = discriminator.familyName;
    }
  }
  return result;
}

function writeProfile(dir: string, fonts: ProfileFonts): void {
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(join(dir, "Default", "Preferences"), `${JSON.stringify({ webkit: { webprefs: { fonts } } })}\n`);
}

async function enable(cdp: CDPSession): Promise<void> {
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
}

async function collectPersistent(dir: string, headless: boolean, opened: BrowserContext[]): Promise<{ context: BrowserContext; page: Page; cdp: CDPSession; rows: ProfileFaceRow[] }> {
  const context = await chromium.launchPersistentContext(dir, { channel: "chrome", headless, args: ["--site-per-process"] });
  opened.push(context);
  const page = context.pages()[0] ?? await context.newPage();
  await page.setContent("<!doctype html><body>profile authority</body>");
  const cdp = await context.newCDPSession(page);
  await enable(cdp);
  return { context, page, cdp, rows: await readRows(page, cdp) };
}

function expectedExact(rows: ProfileFaceRow[], expected: ProfileFonts): number {
  return rows.filter((row) => norm(row.familyName) === norm(expected[row.generic][row.script])).length;
}

async function productionProbeExact(page: Page, rows: ProfileFaceRow[]): Promise<boolean> {
  const probe = await ensureSessionGenericFamilyOverrides(page);
  if (probe == null) return false;
  return rows.every((row) => {
    const generic = row.generic === "fixed" ? "monospace" : row.generic === "sansserif" ? "sans-serif" : row.generic;
    const observed = row.script === "Zyyy" ? probe.common.get(generic) : probe.byScript.get(row.script === "Jpan" ? "KATAKANA_OR_HIRAGANA" : "DEVANAGARI")?.get(generic);
    return norm(observed ?? "") === norm(face(row));
  });
}

function headlessExpected(profile: ProfileFonts, clean: ProfileFaceRow[]): ProfileFonts {
  const result = structuredClone(profile);
  for (const row of clean) result[row.generic][row.script] = row.familyName;
  // Full Chrome's headless profile path retains the Common math preference;
  // Playwright then assigns the other Common fields. Script maps remain the
  // clean headless values, unlike the headed PrefService-owned profile maps.
  result.math.Zyyy = profile.math.Zyyy;
  return result;
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function revision(repo: string): string { try { return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unavailable"; } }

export function adjudicateOverlay(profile: ProfileFonts, clean: ProfileFaceRow[], actual: ProfileFaceRow[]): GenericProfileTargetReport["overlay"] {
  const cleanMap = new Map(clean.map((row) => [key(row), row]));
  const headlessMatchesClean = actual.filter((row) => norm(row.familyName) === norm(cleanMap.get(key(row))!.familyName)).length;
  const supported = actual.filter((row) => profileFieldSupported(row.script, row.generic));
  const profileDiscriminators = supported.filter((row) => norm(profile[row.generic][row.script]) !== norm(cleanMap.get(key(row))!.familyName)).length;
  const profileMapRetainedInHeadless = supported.filter((row) => norm(row.familyName) === norm(profile[row.generic][row.script])).length;
  const expected = headlessExpected(profile, clean);
  return { headlessMatchesClean, profileDiscriminators, profileMapRetainedInHeadless, pass: profileDiscriminators === supported.length && expectedExact(actual, expected) === actual.length };
}

export async function runGenericProfileTargetOracle(): Promise<GenericProfileTargetReport> {
  const dirs = Array.from({ length: 4 }, () => mkdtempSync(join(tmpdir(), "domotion-profile-authority-")));
  const opened: BrowserContext[] = [];
  let targetServer: ReturnType<typeof createServer> | null = null;
  const errors: string[] = [];
  let report: GenericProfileTargetReport | null = null;
  try {
    mkdirSync(join(dirs[0], "Default"), { recursive: true });
    writeFileSync(join(dirs[0], "Default", "Preferences"), "{}\n");
    const discovery = await collectPersistent(dirs[0], false, opened);
    await discovery.context.close();
    mkdirSync(join(dirs[1], "Default"), { recursive: true });
    writeFileSync(join(dirs[1], "Default", "Preferences"), "{}\n");
    const clean = await collectPersistent(dirs[1], true, opened);
    const cleanRows = clean.rows;
    await clean.context.close();
    const profile = rotatedProfile(discovery.rows, cleanRows);
    for (const dir of dirs.slice(2)) writeProfile(dir, profile);
    const headed = await collectPersistent(dirs[2], false, opened);
    const headedProbeExact = await productionProbeExact(headed.page, headed.rows);
    const headedExact = headed.rows.filter((row) => !profileFieldSupported(row.script, row.generic) || norm(row.familyName) === norm(profile[row.generic][row.script])).length;
    const headedReport: ProfileModeReport = { mode: "headed", rows: headed.rows, expectedRows: 21, exactRows: headedExact, productionProbeExact: headedProbeExact, pass: headedExact === 21 && headedProbeExact };
    await headed.context.close();
    const headless = await collectPersistent(dirs[3], true, opened);
    const browserVersion = headless.context.browser()?.version() ?? "unavailable";
    const browserProtocol = await headless.cdp.send("Browser.getVersion");
    const expectedHeadless = headlessExpected(profile, cleanRows);
    const headlessProbeExact = await productionProbeExact(headless.page, headless.rows);
    const headlessExact = expectedExact(headless.rows, expectedHeadless);
    const headlessReport: ProfileModeReport = { mode: "headless", rows: headless.rows, expectedRows: 21, exactRows: headlessExact, productionProbeExact: headlessProbeExact, pass: headlessExact === 21 && headlessProbeExact };
    const overlay = adjudicateOverlay(profile, cleanRows, headless.rows);

    // Ordinary frames inherit one profile-owned Settings state. A fresh CDP
    // session can then create a target-local divergence; production explicitly
    // supports only the non-divergent state and must not infer target authority.
    const server = targetServer = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(request.url === "/child" ? "<!doctype html><body>child</body>" : `<!doctype html><body><iframe src="http://localhost:${(server.address() as { port: number }).port}/child"></iframe></body>`);
    });
    await new Promise<void>((resolveListen, rejectListen) => server.once("error", rejectListen).listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as { port: number }).port;
    await headless.page.goto(`http://127.0.0.1:${port}/main`);
    const frame = headless.page.frames().find((item) => item !== headless.page.mainFrame())!;
    await frame.waitForLoadState("load");
    const frameCdp = await headless.context.newCDPSession(frame);
    await enable(frameCdp);
    const mainBefore = await readRows(headless.page, headless.cdp);
    const childBefore = await readRows(frame, frameCdp);
    const standardFamily = mainBefore.find((row) => row.script === "Zyyy" && row.generic === "standard")!.familyName;
    const mutationFamily = mainBefore.find((row) => row.script === "Zyyy" && norm(row.familyName) !== norm(standardFamily))?.familyName;
    if (mutationFamily == null) throw new Error("OOPIF mutation needs a painted family distinct from Common standard");
    await frameCdp.send("Page.setFontFamilies", { fontFamilies: { standard: mutationFamily } });
    const childAfter = await readRows(frame, frameCdp);
    const mainAfter = await readRows(headless.page, headless.cdp);
    const ordinaryMainFrameExact = expectedExact(mainBefore, expectedHeadless) === 21;
    const ordinaryChildFrameExact = mainBefore.every((row, index) => norm(row.familyName) === norm(childBefore[index].familyName));
    const divergentMutationMovedChild = norm(childBefore.find((row) => row.script === "Zyyy" && row.generic === "standard")!.familyName) !== norm(childAfter.find((row) => row.script === "Zyyy" && row.generic === "standard")!.familyName);
    const divergentMutationLeftMainStable = mainBefore.every((row, index) => norm(row.familyName) === norm(mainAfter[index].familyName));
    await frameCdp.detach();
    await headless.context.close();
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error == null ? resolveClose() : rejectClose(error)));
    const target = { ordinaryMainFrameExact, ordinaryChildFrameExact, divergentMutationMovedChild, divergentMutationLeftMainStable, supportedContract: "non-divergent-target-settings-only" as const, pass: ordinaryMainFrameExact && ordinaryChildFrameExact && divergentMutationMovedChild && divergentMutationLeftMainStable };
    const pass = headedReport.pass && headlessReport.pass && overlay.pass && target.pass;
    report = {
      schemaVersion: 1,
      contract: "logical-profile-and-target-authority-no-pixels",
      environment: { platform: platform(), architecture: arch(), release: release(), node: process.version, browser: browserVersion, browserProduct: browserProtocol.product, browserRevision: browserProtocol.revision, browserUserAgent: browserProtocol.userAgent, browserJsVersion: browserProtocol.jsVersion, preferencesSha256: sha(JSON.stringify(profile)), chromiumSource: revision("external/chromium"), fontInventorySha256: sha(execFileSync(process.execPath, ["tools/font-inventory.mjs"], { encoding: "utf8" })) },
      requestedProfile: profile,
      cleanHeadless: cleanRows,
      headed: headedReport,
      headless: headlessReport,
      overlay,
      target,
      verdict: pass ? "source-exact" : "source-drift",
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    for (const context of opened) await context.close().catch(() => {});
    if (targetServer?.listening) await new Promise<void>((resolveClose) => targetServer!.close(() => resolveClose()));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
  return report ?? { schemaVersion: 1, contract: "logical-profile-and-target-authority-no-pixels", environment: { platform: platform(), architecture: arch() }, requestedProfile: {} as ProfileFonts, cleanHeadless: [], headed: { mode: "headed", rows: [], expectedRows: 21, exactRows: 0, productionProbeExact: false, pass: false }, headless: { mode: "headless", rows: [], expectedRows: 21, exactRows: 0, productionProbeExact: false, pass: false }, overlay: { headlessMatchesClean: 0, profileDiscriminators: 0, profileMapRetainedInHeadless: 0, pass: false }, target: { ordinaryMainFrameExact: false, ordinaryChildFrameExact: false, divergentMutationMovedChild: false, divergentMutationLeftMainStable: false, supportedContract: "non-divergent-target-settings-only", pass: false }, verdict: "unavailable", errors };
}

if (process.argv[1]?.endsWith("generic-profile-target-oracle.ts")) {
  const report = await runGenericProfileTargetOracle();
  const at = process.argv.indexOf("--json");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (at >= 0 && process.argv[at + 1]) writeFileSync(resolve(process.argv[at + 1]), json);
  process.stdout.write(json);
  process.exitCode = report.verdict === "source-exact" ? 0 : 1;
}
