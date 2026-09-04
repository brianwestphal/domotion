/**
 * DM-2539 — authenticated Chrome profile and target-local generic oracle.
 *
 * This gate owns logical state only. It authenticates the installed full
 * Chrome process, the raw isolated-profile preference file, Playwright's exact
 * launch-time Page.setFontFamilies overlay, and independently mutable main/
 * OOPIF renderer Settings. It never captures pixels and owns no tolerance.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type CDPSession, type Frame, type Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const require = createRequire(import.meta.url);

export const GENERICS = ["standard", "fixed", "serif", "sansserif", "cursive", "fantasy", "math"] as const;
export const SCRIPTS = ["Zyyy", "Jpan", "Deva"] as const;
type Generic = typeof GENERICS[number];
type Script = typeof SCRIPTS[number];
type ProtocolFamilyKey = "standard" | "fixed" | "serif" | "sansSerif" | "cursive" | "fantasy" | "math";
type ProtocolFontFamilies = Partial<Record<ProtocolFamilyKey, string>>;
type LaunchOrder = "headed-headless" | "headless-headed";
type TargetOrder = "child-main" | "main-child";
export type ProfileFonts = Record<Generic, Record<Script, string>>;

const REQUIRED_FIELDS = GENERICS.length * SCRIPTS.length;
const PROTOCOL_KEY: Readonly<Record<Generic, ProtocolFamilyKey>> = {
  standard: "standard",
  fixed: "fixed",
  serif: "serif",
  sansserif: "sansSerif",
  cursive: "cursive",
  fantasy: "fantasy",
  math: "math",
};
const GENERIC_FROM_PROTOCOL: Readonly<Record<ProtocolFamilyKey, Generic>> = {
  standard: "standard",
  fixed: "fixed",
  serif: "serif",
  sansSerif: "sansserif",
  cursive: "cursive",
  fantasy: "fantasy",
  math: "math",
};

export interface ProfileFaceRow {
  script: Script;
  generic: Generic;
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface SystemUiFaceRow {
  script: Script;
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface MutationCandidateFaceRow {
  script: Script;
  requestedFamily: string;
  familyName: string;
  postScriptName: string | null;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface PlaywrightOverlayField {
  script: Script;
  generic: Generic;
  requestedFamily: string;
}

export interface PlaywrightOverlayMask {
  platformKey: "linux" | "mac" | "win";
  fields: PlaywrightOverlayField[];
  sourceFieldCount: number;
}

export interface OverlayAdjudication {
  expectedRows: number;
  exactRows: number;
  sourceMaskFields: number;
  maskedRowsExact: number;
  profileRetainedRows: number;
  profileRetainedRowsExact: number;
  mismatches: Array<{ script: Script; generic: Generic; owner: "playwright-overlay" | "profile"; expected: string; actual: string }>;
  pass: boolean;
}

interface MutationField {
  script: Script;
  generic: Generic;
  before: string;
  requested: string;
  nonInert: boolean;
}

interface MutationReport {
  fields: MutationField[];
  requiredFieldCount: number;
  nonInertFieldCount: number;
  distinctRequestedFamiliesByScript: Record<Script, number>;
  pass: boolean;
}

interface PersistedProfileField {
  script: Script;
  generic: Generic;
  requested: string;
  persisted: string | null;
  exact: boolean;
}

interface PersistedProfileReport {
  checkpoint: "written" | "after-headed" | "after-headless";
  preferencesPath: string;
  rawSha256: string;
  fields: PersistedProfileField[];
  requiredFields: number;
  exactFields: number;
  pass: boolean;
}

interface ChromeBinaryIdentity {
  requestedChannel: "chrome";
  registryName: "chrome";
  registryBrowserName: "chromium";
  executablePath: string;
  executableSize: number;
  executableSha256: string;
}

interface ChromeLaunchAuthentication {
  role: string;
  headless: boolean;
  product: string;
  revision: string;
  protocolVersion: string;
  commandExecutable: string | null;
  commandUserDataDir: string | null;
  executablePathExact: boolean;
  userDataDirExact: boolean;
  fullChromeChannelExact: boolean;
  pass: boolean;
}

export interface ProfileModeReport {
  mode: "headed" | "headless";
  rows: ProfileFaceRow[];
  expectedRows: number;
  exactRows: number;
  pass: boolean;
}

interface ProfileOrderReport {
  id: LaunchOrder;
  launchOrder: Array<"headed" | "headless">;
  persisted: PersistedProfileReport[];
  headed: ProfileModeReport;
  headless: ProfileModeReport;
  overlay: OverlayAdjudication;
  pass: boolean;
}

interface TargetSnapshot {
  genericRows: ProfileFaceRow[];
  systemUiRows: SystemUiFaceRow[];
}

interface TargetIdentity {
  targetId: string;
  type: string;
  url: string;
}

interface TargetStepReport {
  mutatedTarget: "main" | "child";
  mutatedTargetExactFields: number;
  otherTargetStableFields: number;
  mainSystemUiStableRows: number;
  childSystemUiStableRows: number;
  pass: boolean;
}

interface TargetOrderReport {
  id: TargetOrder;
  targetIdentity: { main: TargetIdentity; child: TargetIdentity; distinctOopifTargets: boolean };
  baselineMainChildExactFields: number;
  mutation: MutationReport;
  steps: TargetStepReport[];
  final: { main: TargetSnapshot; child: TargetSnapshot };
  pass: boolean;
}

export interface GenericProfileTargetReport {
  schemaVersion: 2;
  ticket: "DM-2539";
  contract: "authenticated-logical-profile-overlay-and-target-authority-no-pixels";
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    release: string;
    node: string;
    browserBinary: ChromeBinaryIdentity | null;
    launches: ChromeLaunchAuthentication[];
    sources: {
      chromium: string;
      harfbuzz: string;
      skia: string;
      playwrightVersion: string;
      playwrightOverlayPath: string;
      playwrightOverlaySha256: string;
    };
    fontInventorySha256: string;
  };
  requestedProfile: ProfileFonts;
  mutation: MutationReport;
  mutationCandidates: MutationCandidateFaceRow[];
  clean: { headed: ProfileFaceRow[]; headless: ProfileFaceRow[] };
  playwrightOverlay: PlaywrightOverlayMask;
  profileOrders: ProfileOrderReport[];
  target: {
    orders: TargetOrderReport[];
    forwardReverseEquivalent: boolean;
    requiredGenericFieldsPerTarget: number;
    requiredSystemUiRowsPerTarget: number;
    supportedContract: "target-local-settings-authenticated-system-ui-separate";
    pass: boolean;
  };
  verdict: "source-exact" | "source-drift" | "unavailable";
  errors: string[];
}

interface CollectedLaunch {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  rows: ProfileFaceRow[];
  systemUiRows: SystemUiFaceRow[];
  authentication: ChromeLaunchAuthentication;
}

interface PlaywrightSources {
  version: string;
  overlayPath: string;
  overlaySha256: string;
  table: Record<string, unknown>;
}

let probeSequence = 0;
const key = (row: Pick<ProfileFaceRow, "script" | "generic">): string => `${row.script}/${row.generic}`;
const systemKey = (row: Pick<SystemUiFaceRow, "script">): string => row.script;
const face = (row: Pick<ProfileFaceRow | SystemUiFaceRow, "familyName" | "postScriptName">): string => row.postScriptName ?? row.familyName;
const norm = (value: string | null | undefined): string => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const nativePath = (value: string): string => {
  const canonical = realpathSync.native(value);
  return platform() === "win32" ? canonical.toLowerCase() : canonical;
};

function revision(repo: string): string {
  try {
    return execFileSync("git", ["-C", resolve(ROOT, repo), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function shaFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

function sourcePlatformKey(value: NodeJS.Platform): PlaywrightOverlayMask["platformKey"] {
  if (value === "darwin") return "mac";
  if (value === "win32") return "win";
  if (value === "linux") return "linux";
  throw new Error(`unsupported Playwright font-overlay platform: ${value}`);
}

function isProtocolKey(value: string): value is ProtocolFamilyKey {
  return value in GENERIC_FROM_PROTOCOL;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

/** Derives the relevant 21-field mask from Playwright's live source table. */
export function derivePlaywrightOverlayMask(platformKey: PlaywrightOverlayMask["platformKey"], sourceTable: Record<string, unknown>): PlaywrightOverlayMask {
  const entry = asObject(sourceTable[platformKey], `Playwright platformToFontFamilies.${platformKey}`);
  const fields: PlaywrightOverlayField[] = [];
  const add = (script: Script, familiesValue: unknown): void => {
    const families = asObject(familiesValue, `${platformKey}/${script}.fontFamilies`);
    for (const [protocolKey, requestedFamily] of Object.entries(families)) {
      if (!isProtocolKey(protocolKey) || typeof requestedFamily !== "string") continue;
      fields.push({ script, generic: GENERIC_FROM_PROTOCOL[protocolKey], requestedFamily });
    }
  };
  add("Zyyy", entry.fontFamilies);
  if (Array.isArray(entry.forScripts)) {
    for (const itemValue of entry.forScripts) {
      const item = asObject(itemValue, `${platformKey}.forScripts[]`);
      const script = String(item.script ?? "").toLowerCase();
      if (script === "jpan") add("Jpan", item.fontFamilies);
      if (script === "deva") add("Deva", item.fontFamilies);
    }
  }
  const unique = new Map(fields.map((field) => [key(field), field]));
  if (unique.size !== fields.length) throw new Error(`duplicate Playwright overlay fields for ${platformKey}`);
  return { platformKey, fields, sourceFieldCount: fields.length };
}

function playwrightSources(): PlaywrightSources {
  const packagePath = require.resolve("playwright-core/package.json");
  const packageRoot = dirname(packagePath);
  const overlayPath = join(packageRoot, "lib/server/chromium/defaultFontFamilies.js");
  const loaded = require(overlayPath) as { platformToFontFamilies?: Record<string, unknown> };
  if (loaded.platformToFontFamilies == null) throw new Error("Playwright font overlay source did not export platformToFontFamilies");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return {
    version: packageJson.version ?? "unknown",
    overlayPath,
    overlaySha256: sha(readFileSync(overlayPath)),
    table: loaded.platformToFontFamilies,
  };
}

async function chromeBinaryIdentity(): Promise<ChromeBinaryIdentity> {
  const packagePath = require.resolve("playwright-core/package.json");
  const registryPath = join(dirname(packagePath), "lib/server/registry/index.js");
  const loaded = require(registryPath) as {
    registry?: { findExecutable(name: string): { name?: string; browserName?: string; executablePath(): string | undefined } | undefined };
  };
  const executable = loaded.registry?.findExecutable("chrome");
  const executablePath = executable?.executablePath();
  if (executable == null || executablePath == null) throw new Error("Playwright registry cannot resolve installed full Chrome channel");
  if (executable.name !== "chrome" || executable.browserName !== "chromium") {
    throw new Error(`unexpected Playwright registry identity: ${String(executable.name)}/${String(executable.browserName)}`);
  }
  return {
    requestedChannel: "chrome",
    registryName: "chrome",
    registryBrowserName: "chromium",
    executablePath: realpathSync.native(executablePath),
    executableSize: statSync(executablePath).size,
    executableSha256: await shaFile(executablePath),
  };
}

async function readFace(cdp: CDPSession, nodeId: number): Promise<Omit<ProfileFaceRow, "script" | "generic">> {
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const painted = fonts.reduce((best, item) => best == null || item.glyphCount > best.glyphCount ? item : best, null as typeof fonts[number] | null);
  if (painted == null) throw new Error("probe node has no painted platform face");
  return {
    familyName: painted.familyName,
    postScriptName: painted.postScriptName || null,
    glyphCount: painted.glyphCount,
    isCustomFont: painted.isCustomFont,
  };
}

async function paintBarrier(owner: Page | Frame): Promise<void> {
  await owner.evaluate(() => new Promise<void>((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint()))));
}

async function readRows(owner: Page | Frame, cdp: CDPSession): Promise<ProfileFaceRow[]> {
  const id = `__domotion_profile_${++probeSequence}`;
  await owner.evaluate(({ id: rootId, generics, scripts }) => {
    const root = document.createElement("div");
    root.id = rootId;
    root.style.cssText = "all:initial;position:absolute;left:0;top:0;display:block;pointer-events:none";
    for (const script of scripts) for (const generic of generics) {
      const span = document.createElement("span");
      span.id = `${rootId}_${script}_${generic}`;
      span.style.cssText = "all:initial;display:block;font-size:32px;line-height:normal";
      if (generic !== "standard") span.style.fontFamily = generic === "fixed" ? "monospace" : generic === "sansserif" ? "sans-serif" : generic;
      if (script === "Jpan") {
        span.lang = "ja";
        span.style.setProperty("-webkit-locale", '"ja"');
      }
      if (script === "Deva") {
        span.lang = "hi";
        span.style.setProperty("-webkit-locale", '"hi"');
      }
      span.textContent = script === "Jpan" ? "日" : script === "Deva" ? "अ" : "A";
      root.appendChild(span);
    }
    document.documentElement.appendChild(root);
  }, { id, generics: GENERICS, scripts: SCRIPTS });
  await paintBarrier(owner);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows: ProfileFaceRow[] = [];
    for (const script of SCRIPTS) for (const generic of GENERICS) {
      const found = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}_${script}_${generic}` });
      if (found.nodeId === 0) throw new Error(`lost generic probe ${script}/${generic}`);
      rows.push({ script, generic, ...await readFace(cdp, found.nodeId) });
    }
    return rows;
  } finally {
    await owner.evaluate((probeId) => document.getElementById(probeId)?.remove(), id).catch(() => undefined);
  }
}

export const WINDOWS_PROFILE_FIXTURE_FAMILIES = [
  "Domotion Profile Devanagari One",
  "Domotion Profile Devanagari Two",
] as const;

const WINDOWS_DEVANAGARI_CANDIDATES = [
  ...WINDOWS_PROFILE_FIXTURE_FAMILIES,
  "Aparajita",
  "Kokila",
  "Mangal",
  "Sanskrit Text",
  "Utsaah",
] as const;

/**
 * Authenticate installed candidates through the same painted-face CDP signal
 * as the generic rows. Windows maps every clean Devanagari generic to Nirmala
 * UI even after the supplemental font capability is installed, so the clean
 * generic rows alone cannot name a non-inert mutation. An explicit-family
 * probe proves which supplemental faces are actually available; missing names
 * simply paint as Nirmala and disappear during face-identity deduplication.
 */
async function readMutationCandidateRows(owner: Page | Frame, cdp: CDPSession): Promise<MutationCandidateFaceRow[]> {
  const requested = platform() === "win32"
    ? WINDOWS_DEVANAGARI_CANDIDATES.map((requestedFamily) => ({ script: "Deva" as const, requestedFamily }))
    : [];
  if (requested.length === 0) return [];
  const id = `__domotion_mutation_candidates_${++probeSequence}`;
  await owner.evaluate(({ id: rootId, rows }) => {
    const root = document.createElement("div");
    root.id = rootId;
    root.style.cssText = "all:initial;position:absolute;left:0;top:0;display:block;pointer-events:none";
    for (const [index, row] of rows.entries()) {
      const span = document.createElement("span");
      span.id = `${rootId}_${index}`;
      span.lang = "hi";
      span.style.cssText = "all:initial;display:block;font-size:32px;line-height:normal";
      span.style.fontFamily = row.requestedFamily;
      span.style.setProperty("-webkit-locale", '"hi"');
      span.textContent = "अ";
      root.appendChild(span);
    }
    document.documentElement.appendChild(root);
  }, { id, rows: requested });
  await paintBarrier(owner);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows: MutationCandidateFaceRow[] = [];
    for (const [index, request] of requested.entries()) {
      const found = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}_${index}` });
      if (found.nodeId === 0) throw new Error(`lost mutation candidate probe ${request.script}/${request.requestedFamily}`);
      rows.push({ ...request, ...await readFace(cdp, found.nodeId) });
    }
    return rows;
  } finally {
    await owner.evaluate((probeId) => document.getElementById(probeId)?.remove(), id).catch(() => undefined);
  }
}

async function readSystemUiRows(owner: Page | Frame, cdp: CDPSession): Promise<SystemUiFaceRow[]> {
  const id = `__domotion_system_ui_${++probeSequence}`;
  await owner.evaluate(({ id: rootId, scripts }) => {
    const root = document.createElement("div");
    root.id = rootId;
    root.style.cssText = "all:initial;position:absolute;left:0;top:0;display:block;pointer-events:none";
    for (const script of scripts) {
      const span = document.createElement("span");
      span.id = `${rootId}_${script}`;
      span.style.cssText = "all:initial;display:block;font-family:system-ui;font-size:32px;line-height:normal";
      if (script === "Jpan") {
        span.lang = "ja";
        span.style.setProperty("-webkit-locale", '"ja"');
      }
      if (script === "Deva") {
        span.lang = "hi";
        span.style.setProperty("-webkit-locale", '"hi"');
      }
      // Keep the separation control on a glyph owned by every platform UI
      // face. Han/Devanagari glyph fallback can legitimately consult other
      // fallback routes after system-ui and would no longer isolate whether
      // Page.setFontFamilies itself owns system-ui.
      span.textContent = "A";
      root.appendChild(span);
    }
    document.documentElement.appendChild(root);
  }, { id, scripts: SCRIPTS });
  await paintBarrier(owner);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows: SystemUiFaceRow[] = [];
    for (const script of SCRIPTS) {
      const found = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}_${script}` });
      if (found.nodeId === 0) throw new Error(`lost system-ui probe ${script}`);
      rows.push({ script, ...await readFace(cdp, found.nodeId) });
    }
    return rows;
  } finally {
    await owner.evaluate((probeId) => document.getElementById(probeId)?.remove(), id).catch(() => undefined);
  }
}

async function enable(cdp: CDPSession): Promise<void> {
  await Promise.all([cdp.send("DOM.enable"), cdp.send("CSS.enable")]);
}

function userDataDirFromArguments(args: string[]): string | null {
  const prefix = "--user-data-dir=";
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function authenticateLaunch(cdp: CDPSession, binary: ChromeBinaryIdentity, dir: string, role: string, headless: boolean): Promise<ChromeLaunchAuthentication> {
  const [version, command] = await Promise.all([
    cdp.send("Browser.getVersion"),
    cdp.send("Browser.getBrowserCommandLine"),
  ]);
  const commandExecutable = command.arguments[0] ?? null;
  const commandUserDataDir = userDataDirFromArguments(command.arguments);
  const executablePathExact = commandExecutable != null && nativePath(commandExecutable) === nativePath(binary.executablePath);
  const userDataDirExact = commandUserDataDir != null && nativePath(commandUserDataDir) === nativePath(dir);
  const fullChromeChannelExact = /^Chrome\//.test(version.product) && binary.requestedChannel === "chrome" && binary.registryName === "chrome";
  return {
    role,
    headless,
    product: version.product,
    revision: version.revision,
    protocolVersion: version.protocolVersion,
    commandExecutable,
    commandUserDataDir,
    executablePathExact,
    userDataDirExact,
    fullChromeChannelExact,
    pass: executablePathExact && userDataDirExact && fullChromeChannelExact,
  };
}

async function collectPersistent(dir: string, headless: boolean, role: string, binary: ChromeBinaryIdentity, opened: Set<BrowserContext>): Promise<CollectedLaunch> {
  const context = await chromium.launchPersistentContext(dir, { channel: "chrome", headless, args: ["--site-per-process"] });
  opened.add(context);
  // Persistent Chrome creates an initial target while Playwright is attaching.
  // Exercise an explicitly created target so its source-owned initialization
  // path (_setDefaultFontFamilies in crPage.js) has completed before probing.
  const initialPages = context.pages();
  const page = await context.newPage();
  await Promise.all(initialPages.map((initial) => initial.close()));
  await page.setContent("<!doctype html><meta charset=utf-8><body>DM-2539 profile authority</body>");
  const cdp = await context.newCDPSession(page);
  await enable(cdp);
  const authentication = await authenticateLaunch(cdp, binary, dir, role, headless);
  return {
    context,
    page,
    cdp,
    rows: await readRows(page, cdp),
    systemUiRows: await readSystemUiRows(page, cdp),
    authentication,
  };
}

async function closeCollected(launch: CollectedLaunch, opened: Set<BrowserContext>): Promise<void> {
  await launch.cdp.detach().catch(() => undefined);
  await launch.context.close();
  opened.delete(launch.context);
}

function validateRows(rows: ProfileFaceRow[], label: string): void {
  const found = new Set(rows.map(key));
  if (rows.length !== REQUIRED_FIELDS || found.size !== REQUIRED_FIELDS) {
    throw new Error(`${label} requires ${REQUIRED_FIELDS} unique rows, found ${rows.length}/${found.size}`);
  }
  for (const script of SCRIPTS) for (const generic of GENERICS) {
    if (!found.has(`${script}/${generic}`)) throw new Error(`${label} is missing ${script}/${generic}`);
  }
}

export function deriveNonInertProfile(
  rows: ProfileFaceRow[],
  mutationCandidates: readonly MutationCandidateFaceRow[] = [],
): { profile: ProfileFonts; mutation: MutationReport } {
  validateRows(rows, "mutation baseline");
  const profile = Object.fromEntries(GENERICS.map((generic) => [generic, {}])) as ProfileFonts;
  const fields: MutationField[] = [];
  const distinctRequestedFamiliesByScript = {} as Record<Script, number>;
  for (const script of SCRIPTS) {
    const scriptRows = rows.filter((row) => row.script === script);
    const candidateRows = [
      ...scriptRows,
      ...mutationCandidates.filter((row) => row.script === script).map((row) => ({
        ...row,
        generic: scriptRows[0].generic,
      })),
    ];
    const candidates = candidateRows.filter((row, index) =>
      candidateRows.findIndex((other) => norm(face(other)) === norm(face(row))) === index);
    if (candidates.length < 2) throw new Error(`non-inert mutation needs two painted ${script} families`);
    for (const [index, generic] of GENERICS.entries()) {
      const before = scriptRows.find((row) => row.generic === generic)!;
      const eligible = candidates.filter((candidate) => norm(face(candidate)) !== norm(face(before)));
      if (eligible.length === 0) throw new Error(`no non-inert candidate for ${script}/${generic}`);
      const requested = eligible[index % eligible.length].familyName;
      profile[generic][script] = requested;
      fields.push({ script, generic, before: before.familyName, requested, nonInert: norm(face(before)) !== norm(face(eligible[index % eligible.length])) });
    }
    distinctRequestedFamiliesByScript[script] = new Set(GENERICS.map((generic) => norm(profile[generic][script]))).size;
  }
  const nonInertFieldCount = fields.filter((field) => field.nonInert).length;
  const pass = nonInertFieldCount === REQUIRED_FIELDS && SCRIPTS.every((script) => distinctRequestedFamiliesByScript[script] >= 2);
  return {
    profile,
    mutation: { fields, requiredFieldCount: REQUIRED_FIELDS, nonInertFieldCount, distinctRequestedFamiliesByScript, pass },
  };
}

function writeProfile(dir: string, fonts: ProfileFonts): PersistedProfileReport {
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(join(dir, "Default", "Preferences"), `${JSON.stringify({ webkit: { webprefs: { fonts } } })}\n`);
  return readPersistedProfile(dir, fonts, "written");
}

function readPersistedProfile(dir: string, expected: ProfileFonts, checkpoint: PersistedProfileReport["checkpoint"]): PersistedProfileReport {
  const preferencesPath = join(dir, "Default", "Preferences");
  const raw = readFileSync(preferencesPath);
  const parsed = JSON.parse(raw.toString("utf8")) as { webkit?: { webprefs?: { fonts?: Record<string, Record<string, unknown>> } } };
  const fonts = parsed.webkit?.webprefs?.fonts;
  const fields: PersistedProfileField[] = [];
  for (const script of SCRIPTS) for (const generic of GENERICS) {
    const value = fonts?.[generic]?.[script];
    const persisted = typeof value === "string" ? value : null;
    fields.push({ script, generic, requested: expected[generic][script], persisted, exact: persisted != null && norm(persisted) === norm(expected[generic][script]) });
  }
  const exactFields = fields.filter((field) => field.exact).length;
  return { checkpoint, preferencesPath, rawSha256: sha(raw), fields, requiredFields: REQUIRED_FIELDS, exactFields, pass: exactFields === REQUIRED_FIELDS };
}

function expectedProfileExact(rows: ProfileFaceRow[], expected: ProfileFonts): number {
  validateRows(rows, "profile observation");
  return rows.filter((row) => norm(row.familyName) === norm(expected[row.generic][row.script])).length;
}

function rowsExact(actual: ProfileFaceRow[], expected: ProfileFaceRow[]): number {
  validateRows(actual, "actual target rows");
  validateRows(expected, "expected target rows");
  const expectedMap = new Map(expected.map((row) => [key(row), row]));
  return actual.filter((row) => norm(face(row)) === norm(face(expectedMap.get(key(row))))).length;
}

function systemRowsExact(actual: SystemUiFaceRow[], expected: SystemUiFaceRow[]): number {
  const expectedMap = new Map(expected.map((row) => [systemKey(row), row]));
  return actual.filter((row) => norm(face(row)) === norm(face(expectedMap.get(systemKey(row))))).length;
}

export function adjudicateOverlay(profileRows: ProfileFaceRow[], cleanHeadless: ProfileFaceRow[], actual: ProfileFaceRow[], mask: PlaywrightOverlayMask): OverlayAdjudication {
  validateRows(profileRows, "profile overlay baseline");
  validateRows(cleanHeadless, "clean headless overlay baseline");
  validateRows(actual, "headless overlay observation");
  const profileMap = new Map(profileRows.map((row) => [key(row), row]));
  const cleanMap = new Map(cleanHeadless.map((row) => [key(row), row]));
  const maskKeys = new Set(mask.fields.map(key));
  const mismatches: OverlayAdjudication["mismatches"] = [];
  let maskedRowsExact = 0;
  let profileRetainedRowsExact = 0;
  for (const row of actual) {
    const ownedByOverlay = maskKeys.has(key(row));
    const expected = (ownedByOverlay ? cleanMap : profileMap).get(key(row))!;
    const exact = norm(face(row)) === norm(face(expected));
    if (ownedByOverlay && exact) maskedRowsExact++;
    if (!ownedByOverlay && exact) profileRetainedRowsExact++;
    if (!exact) mismatches.push({ script: row.script, generic: row.generic, owner: ownedByOverlay ? "playwright-overlay" : "profile", expected: face(expected), actual: face(row) });
  }
  const profileRetainedRows = REQUIRED_FIELDS - maskKeys.size;
  const exactRows = maskedRowsExact + profileRetainedRowsExact;
  return {
    expectedRows: REQUIRED_FIELDS,
    exactRows,
    sourceMaskFields: maskKeys.size,
    maskedRowsExact,
    profileRetainedRows,
    profileRetainedRowsExact,
    mismatches,
    pass: maskKeys.size === mask.sourceFieldCount && exactRows === REQUIRED_FIELDS,
  };
}

function modeReport(mode: ProfileModeReport["mode"], launch: CollectedLaunch, exactRows: number): ProfileModeReport {
  return { mode, rows: launch.rows, expectedRows: REQUIRED_FIELDS, exactRows, pass: exactRows === REQUIRED_FIELDS };
}

function protocolProfile(profile: ProfileFonts): { fontFamilies: ProtocolFontFamilies; forScripts: Array<{ script: string; fontFamilies: ProtocolFontFamilies }> } {
  const forScript = (script: Script): ProtocolFontFamilies => Object.fromEntries(
    GENERICS.map((generic) => [PROTOCOL_KEY[generic], profile[generic][script]]),
  );
  return {
    fontFamilies: forScript("Zyyy"),
    forScripts: SCRIPTS.filter((script) => script !== "Zyyy").map((script) => ({ script: script.toLowerCase(), fontFamilies: forScript(script) })),
  };
}

function profileExactSnapshot(snapshot: TargetSnapshot, profile: ProfileFonts): number {
  return expectedProfileExact(snapshot.genericRows, profile);
}

async function targetSnapshot(owner: Page | Frame, cdp: CDPSession): Promise<TargetSnapshot> {
  return { genericRows: await readRows(owner, cdp), systemUiRows: await readSystemUiRows(owner, cdp) };
}

async function targetInfo(cdp: CDPSession): Promise<TargetIdentity> {
  const { targetInfo: info } = await cdp.send("Target.getTargetInfo");
  return { targetId: info.targetId, type: info.type, url: info.url };
}

async function runTargetOrder(args: {
  id: TargetOrder;
  dir: string;
  profile: ProfileFonts;
  binary: ChromeBinaryIdentity;
  opened: Set<BrowserContext>;
  launches: ChromeLaunchAuthentication[];
  targetUrl: string;
}): Promise<TargetOrderReport> {
  writeProfile(args.dir, args.profile);
  const launch = await collectPersistent(args.dir, true, `target-${args.id}`, args.binary, args.opened);
  args.launches.push(launch.authentication);
  let childCdp: CDPSession | null = null;
  try {
    await launch.page.goto(args.targetUrl);
    const child = launch.page.frames().find((frame) => frame !== launch.page.mainFrame());
    if (child == null) throw new Error(`${args.id}: cross-site child frame not found`);
    await child.waitForLoadState("load");
    childCdp = await launch.context.newCDPSession(child);
    await enable(childCdp);
    const [mainIdentity, childIdentity] = await Promise.all([targetInfo(launch.cdp), targetInfo(childCdp)]);
    const distinctOopifTargets = mainIdentity.targetId !== childIdentity.targetId
      && mainIdentity.type === "page"
      && childIdentity.type === "iframe"
      && new URL(mainIdentity.url).hostname !== new URL(childIdentity.url).hostname;
    const baseline = {
      main: await targetSnapshot(launch.page, launch.cdp),
      child: await targetSnapshot(child, childCdp),
    };
    const baselineMainChildExactFields = rowsExact(baseline.main.genericRows, baseline.child.genericRows);
    const { profile: mutationProfile, mutation } = deriveNonInertProfile(baseline.main.genericRows);
    const payload = protocolProfile(mutationProfile);
    const current = { main: baseline.main, child: baseline.child };
    const steps: TargetStepReport[] = [];
    for (const mutatedTarget of args.id === "child-main" ? ["child", "main"] as const : ["main", "child"] as const) {
      const otherTarget = mutatedTarget === "main" ? "child" : "main";
      const cdp = mutatedTarget === "main" ? launch.cdp : childCdp;
      await cdp.send("Page.setFontFamilies", payload);
      const next = {
        main: await targetSnapshot(launch.page, launch.cdp),
        child: await targetSnapshot(child, childCdp),
      };
      const mutatedTargetExactFields = profileExactSnapshot(next[mutatedTarget], mutationProfile);
      const otherTargetStableFields = rowsExact(next[otherTarget].genericRows, current[otherTarget].genericRows);
      const mainSystemUiStableRows = systemRowsExact(next.main.systemUiRows, baseline.main.systemUiRows);
      const childSystemUiStableRows = systemRowsExact(next.child.systemUiRows, baseline.child.systemUiRows);
      const pass = mutatedTargetExactFields === REQUIRED_FIELDS
        && otherTargetStableFields === REQUIRED_FIELDS
        && mainSystemUiStableRows === SCRIPTS.length
        && childSystemUiStableRows === SCRIPTS.length;
      steps.push({ mutatedTarget, mutatedTargetExactFields, otherTargetStableFields, mainSystemUiStableRows, childSystemUiStableRows, pass });
      current.main = next.main;
      current.child = next.child;
    }
    const pass = distinctOopifTargets
      && baselineMainChildExactFields === REQUIRED_FIELDS
      && mutation.pass
      && steps.length === 2
      && steps.every((step) => step.pass)
      && profileExactSnapshot(current.main, mutationProfile) === REQUIRED_FIELDS
      && profileExactSnapshot(current.child, mutationProfile) === REQUIRED_FIELDS;
    return {
      id: args.id,
      targetIdentity: { main: mainIdentity, child: childIdentity, distinctOopifTargets },
      baselineMainChildExactFields,
      mutation,
      steps,
      final: current,
      pass,
    };
  } finally {
    await childCdp?.detach().catch(() => undefined);
    await closeCollected(launch, args.opened).catch(() => undefined);
  }
}

function targetOrdersEquivalent(first: TargetOrderReport, second: TargetOrderReport): boolean {
  return rowsExact(first.final.main.genericRows, second.final.main.genericRows) === REQUIRED_FIELDS
    && rowsExact(first.final.child.genericRows, second.final.child.genericRows) === REQUIRED_FIELDS
    && systemRowsExact(first.final.main.systemUiRows, second.final.main.systemUiRows) === SCRIPTS.length
    && systemRowsExact(first.final.child.systemUiRows, second.final.child.systemUiRows) === SCRIPTS.length;
}

function emptyProfile(): ProfileFonts {
  return Object.fromEntries(GENERICS.map((generic) => [generic, Object.fromEntries(SCRIPTS.map((script) => [script, ""]))])) as ProfileFonts;
}

function unavailableReport(errors: string[], sources: PlaywrightSources | null, overlay: PlaywrightOverlayMask | null): GenericProfileTargetReport {
  return {
    schemaVersion: 2,
    ticket: "DM-2539",
    contract: "authenticated-logical-profile-overlay-and-target-authority-no-pixels",
    environment: {
      platform: platform(),
      architecture: arch(),
      release: release(),
      node: process.version,
      browserBinary: null,
      launches: [],
      sources: {
        chromium: revision("external/chromium"),
        harfbuzz: revision("external/harfbuzz"),
        skia: revision("external/skia"),
        playwrightVersion: sources?.version ?? "unavailable",
        playwrightOverlayPath: sources?.overlayPath ?? "unavailable",
        playwrightOverlaySha256: sources?.overlaySha256 ?? "unavailable",
      },
      fontInventorySha256: "unavailable",
    },
    requestedProfile: emptyProfile(),
    mutation: { fields: [], requiredFieldCount: REQUIRED_FIELDS, nonInertFieldCount: 0, distinctRequestedFamiliesByScript: { Zyyy: 0, Jpan: 0, Deva: 0 }, pass: false },
    mutationCandidates: [],
    clean: { headed: [], headless: [] },
    playwrightOverlay: overlay ?? { platformKey: sourcePlatformKey(platform()), fields: [], sourceFieldCount: 0 },
    profileOrders: [],
    target: { orders: [], forwardReverseEquivalent: false, requiredGenericFieldsPerTarget: REQUIRED_FIELDS, requiredSystemUiRowsPerTarget: SCRIPTS.length, supportedContract: "target-local-settings-authenticated-system-ui-separate", pass: false },
    verdict: "unavailable",
    errors,
  };
}

export async function runGenericProfileTargetOracle(
  options: { allowHeadedBrowser?: boolean } = {},
): Promise<GenericProfileTargetReport> {
  if (options.allowHeadedBrowser !== true) {
    return unavailableReport([
      "Error: headed Chrome is disabled; pass --allow-headed-browser only on an isolated validation host",
    ], null, null);
  }
  const dirs = Array.from({ length: 6 }, () => mkdtempSync(join(tmpdir(), "domotion-profile-authority-")));
  const opened = new Set<BrowserContext>();
  const launches: ChromeLaunchAuthentication[] = [];
  let targetServer: ReturnType<typeof createServer> | null = null;
  let sources: PlaywrightSources | null = null;
  let overlay: PlaywrightOverlayMask | null = null;
  const errors: string[] = [];
  try {
    sources = playwrightSources();
    overlay = derivePlaywrightOverlayMask(sourcePlatformKey(platform()), sources.table);
    const binary = await chromeBinaryIdentity();

    const cleanHeaded = await collectPersistent(dirs[0], false, "clean-headed", binary, opened);
    launches.push(cleanHeaded.authentication);
    await closeCollected(cleanHeaded, opened);
    const cleanHeadless = await collectPersistent(dirs[1], true, "clean-headless", binary, opened);
    launches.push(cleanHeadless.authentication);
    const mutationCandidates = await readMutationCandidateRows(cleanHeadless.page, cleanHeadless.cdp);
    await closeCollected(cleanHeadless, opened);

    // The explicitly created headless target carries Playwright's exact
    // source table. Its painted families are therefore known-good mutation
    // names for both CDP and the same installed full-Chrome profile route.
    const derived = deriveNonInertProfile(cleanHeadless.rows, mutationCandidates);
    const profileOrders: ProfileOrderReport[] = [];
    for (const [index, id] of (["headed-headless", "headless-headed"] as const).entries()) {
      const dir = dirs[index + 2];
      const persisted: PersistedProfileReport[] = [writeProfile(dir, derived.profile)];
      const modes = new Map<"headed" | "headless", CollectedLaunch>();
      const order: Array<"headed" | "headless"> = id === "headed-headless" ? ["headed", "headless"] : ["headless", "headed"];
      for (const mode of order) {
        const launch = await collectPersistent(dir, mode === "headless", `profile-${id}-${mode}`, binary, opened);
        launches.push(launch.authentication);
        modes.set(mode, launch);
        await closeCollected(launch, opened);
        persisted.push(readPersistedProfile(dir, derived.profile, mode === "headed" ? "after-headed" : "after-headless"));
      }
      const headed = modes.get("headed")!;
      const headless = modes.get("headless")!;
      const headedReport = modeReport("headed", headed, expectedProfileExact(headed.rows, derived.profile));
      const overlayReport = adjudicateOverlay(headed.rows, cleanHeadless.rows, headless.rows, overlay);
      const headlessReport = modeReport("headless", headless, overlayReport.exactRows);
      const pass = persisted.every((checkpoint) => checkpoint.pass) && headedReport.pass && headlessReport.pass && overlayReport.pass;
      profileOrders.push({ id, launchOrder: order, persisted, headed: headedReport, headless: headlessReport, overlay: overlayReport, pass });
    }

    const server = targetServer = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(request.url === "/child"
        ? "<!doctype html><meta charset=utf-8><body>DM-2539 child</body>"
        : `<!doctype html><meta charset=utf-8><body><iframe src="http://localhost:${(server.address() as { port: number }).port}/child"></iframe></body>`);
    });
    await new Promise<void>((resolveListen, rejectListen) => server.once("error", rejectListen).listen(0, "127.0.0.1", resolveListen));
    const targetUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/main`;
    const targetOrders = [
      await runTargetOrder({ id: "child-main", dir: dirs[4], profile: derived.profile, binary, opened, launches, targetUrl }),
      await runTargetOrder({ id: "main-child", dir: dirs[5], profile: derived.profile, binary, opened, launches, targetUrl }),
    ];
    const forwardReverseEquivalent = targetOrdersEquivalent(targetOrders[0], targetOrders[1]);
    const targetPass = targetOrders.every((order) => order.pass) && forwardReverseEquivalent;
    const binaryPass = launches.length === 8 && launches.every((launch) => launch.pass);
    const pass = binaryPass && derived.mutation.pass && profileOrders.every((order) => order.pass) && targetPass;
    const fontInventory = execFileSync(process.execPath, [resolve(ROOT, "tools/font-inventory.mjs")], { encoding: "utf8" });
    return {
      schemaVersion: 2,
      ticket: "DM-2539",
      contract: "authenticated-logical-profile-overlay-and-target-authority-no-pixels",
      environment: {
        platform: platform(),
        architecture: arch(),
        release: release(),
        node: process.version,
        browserBinary: binary,
        launches,
        sources: {
          chromium: revision("external/chromium"),
          harfbuzz: revision("external/harfbuzz"),
          skia: revision("external/skia"),
          playwrightVersion: sources.version,
          playwrightOverlayPath: sources.overlayPath,
          playwrightOverlaySha256: sources.overlaySha256,
        },
        fontInventorySha256: sha(fontInventory),
      },
      requestedProfile: derived.profile,
      mutation: derived.mutation,
      mutationCandidates,
      clean: { headed: cleanHeaded.rows, headless: cleanHeadless.rows },
      playwrightOverlay: overlay,
      profileOrders,
      target: {
        orders: targetOrders,
        forwardReverseEquivalent,
        requiredGenericFieldsPerTarget: REQUIRED_FIELDS,
        requiredSystemUiRowsPerTarget: SCRIPTS.length,
        supportedContract: "target-local-settings-authenticated-system-ui-separate",
        pass: targetPass,
      },
      verdict: pass ? "source-exact" : "source-drift",
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return unavailableReport(errors, sources, overlay);
  } finally {
    for (const context of opened) await context.close().catch(() => undefined);
    if (targetServer?.listening) await new Promise<void>((resolveClose) => targetServer!.close(() => resolveClose()));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("generic-profile-target-oracle.ts")) {
  const report = await runGenericProfileTargetOracle({
    allowHeadedBrowser: process.argv.includes("--allow-headed-browser"),
  });
  const at = process.argv.indexOf("--json");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (at >= 0 && process.argv[at + 1]) writeFileSync(resolve(process.argv[at + 1]), json);
  process.stdout.write(json);
  process.exitCode = report.verdict === "source-exact" ? 0 : 1;
}
