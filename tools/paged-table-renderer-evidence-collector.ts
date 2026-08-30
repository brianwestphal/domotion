#!/usr/bin/env node
/** Collect Blink-private paged-table records without reading PDF output. */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type CDPSession, type Page } from "playwright";

import {
  buildPagedCollapsedTableRecord,
  type AuthenticatedPagedCollapsedTableRecord,
} from "../src/capture/paged-collapsed-table-record.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import {
  PAGED_TABLE_EVIDENCE_FIXTURES,
  REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
  validatePagedTableEvidenceFixtures,
} from "./paged-table-evidence-fixtures.js";
import {
  PAGED_TABLE_RENDERER_EVIDENCE_ABI,
  PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION,
  PAGED_TABLE_RENDERER_EVIDENCE_DEPOT_TOOLS_REVISION,
  PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES,
  PAGED_TABLE_RENDERER_EVIDENCE_SKIA_REVISION,
  pagedTableEvidenceDigest,
  pagedTableRendererArtifactDigest,
  pagedTableRendererPlatformPackaging,
  rendererCaseProvesMatrixCell,
  runPagedTableRendererHostileMutations,
  validateBlinkPagedTableRendererPayload,
  validatePagedTableRendererEvidenceArtifact,
  type BlinkPagedTableRendererPayload,
  type PagedTableRendererDefaultOffControl,
  type PagedTableRendererEvidenceArtifact,
  type PagedTableRendererEvidenceCase,
  type PagedTableRendererPrintRequest,
} from "./paged-table-renderer-evidence-schema.js";

const argv = process.argv.slice(2);
const value = (flag: string, fallback: string): string => {
  const index = argv.indexOf(flag);
  const result = index < 0 ? fallback : argv[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`missing ${flag}`);
  return result;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sourceRoot = resolve(value(
  "--source-root", ".chromium-build/worktrees/dm2573/src",
));
const depotTools = resolve(value("--depot-tools", ".chromium-build/depot_tools"));
const binaryPath = resolve(value(
  "--binary", `${sourceRoot}/out/DM2573/headless_shell`,
));
const patchPath = resolve(value(
  "--patch", "tools/chromium-paged-table-evidence/renderer-helper.patch",
));
const outputPath = resolve(value(
  "--out", ".pr-notes/artifacts/dm2573-paged-table-renderer-evidence.json",
));

const shaBytes = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const fileSha = (path: string): string => shaBytes(readFileSync(path));
const sourceFileHashes = () => ({
  buildHelperSha256: fileSha(resolve(
    projectRoot, "tools/build-paged-table-pinned-chromium-helper.mjs",
  )),
  collectorSha256: fileSha(resolve(
    projectRoot, "tools/paged-table-renderer-evidence-collector.ts",
  )),
  fixtureManifestSha256: fileSha(resolve(
    projectRoot, "tools/paged-table-evidence-fixtures.ts",
  )),
  evidenceSchemaSha256: fileSha(resolve(
    projectRoot, "tools/paged-table-renderer-evidence-schema.ts",
  )),
  recordSchemaSha256: fileSha(resolve(
    projectRoot, "src/capture/paged-collapsed-table-record.ts",
  )),
});
const gitRevision = (path: string): string => execFileSync(
  "git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" },
).trim();

type RawCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function rawSend(
  cdp: CDPSession,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (cdp as unknown as RawCdp).send(method, params);
}

async function sourceStateSha256(page: Page): Promise<string> {
  const state = await page.evaluate(() => ({
    url: document.URL,
    html: document.documentElement.outerHTML,
    readyState: document.readyState,
    activeElement: document.activeElement == null
      ? null
      : {
        tagName: document.activeElement.tagName,
        id: document.activeElement.id,
        className: document.activeElement.getAttribute("class"),
      },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      rootLeft: document.scrollingElement?.scrollLeft ?? null,
      rootTop: document.scrollingElement?.scrollTop ?? null,
    },
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      printMediaMatches: window.matchMedia("print").matches,
    },
    styleSheets: Array.from(document.styleSheets, (sheet) =>
      Array.from(sheet.cssRules, (rule) => rule.cssText)),
    elements: Array.from(document.querySelectorAll("*"), (element) => {
      const style = getComputedStyle(element);
      return {
        tagName: element.tagName,
        id: element.id,
        className: element.getAttribute("class"),
        styleAttribute: element.getAttribute("style"),
        computed: {
          display: style.display,
          position: style.position,
          writingMode: style.writingMode,
          direction: style.direction,
          borderCollapse: style.borderCollapse,
          breakBefore: style.breakBefore,
          breakAfter: style.breakAfter,
          breakInside: style.breakInside,
        },
        clientRects: Array.from(element.getClientRects(), (rect) => ({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })),
      };
    }),
  }));
  return pagedTableEvidenceDigest(state);
}

async function processId(cdp: CDPSession, role: "browser" | "renderer", id?: number) {
  const response = await cdp.send("SystemInfo.getProcessInfo");
  const row = response.processInfo.find((entry) =>
    entry.type.toLowerCase() === role && (id == null || entry.id === id));
  if (!row || !Number.isInteger(row.id) || row.id <= 0) {
    throw new Error(`${role} process is not live in SystemInfo`);
  }
  return row.id;
}

function processExecutablePath(processId: number): string {
  if (process.platform === "darwin") {
    const lines = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", "-Ffn", "-a", "-p", String(processId), "-d", "txt"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).split("\n");
    for (let index = 0; index + 1 < lines.length; index++) {
      if (lines[index] === "ftxt" && lines[index + 1].startsWith("n/")) {
        return resolve(lines[index + 1].slice(1));
      }
    }
    throw new Error(`macOS executable mapping is absent for process ${processId}`);
  }
  if (process.platform === "linux") {
    return resolve(readlinkSync(`/proc/${processId}/exe`));
  }
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${processId} -ErrorAction Stop).Path`;
    const result = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).trim();
    if (result === "") throw new Error(`Windows executable mapping is absent for process ${processId}`);
    return resolve(result);
  }
  throw new Error("live process executable authentication is unsupported on this host");
}

function assertPinnedInputs(): void {
  for (const path of [binaryPath, patchPath]) {
    if (!statSync(path).isFile()) throw new Error(`missing pinned helper input ${path}`);
  }
  if (gitRevision(sourceRoot) !== PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION
      || gitRevision(`${sourceRoot}/third_party/skia`)
        !== PAGED_TABLE_RENDERER_EVIDENCE_SKIA_REVISION
      || gitRevision(depotTools) !== PAGED_TABLE_RENDERER_EVIDENCE_DEPOT_TOOLS_REVISION) {
    throw new Error("Chromium/Skia/depot_tools source does not match the DM-2573 pins");
  }
  const installedSourceDelta = execFileSync(
    "git", ["-C", sourceRoot, "diff", "--binary"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (!installedSourceDelta.equals(readFileSync(patchPath))) {
    throw new Error("installed Chromium source delta differs from the retained DM-2573 patch");
  }
  const fixtureErrors = validatePagedTableEvidenceFixtures();
  if (fixtureErrors.length > 0) throw new Error(fixtureErrors.join("; "));
}

async function collectDefaultOffControl(
  browser: Browser,
): Promise<PagedTableRendererDefaultOffControl> {
  const fixture = PAGED_TABLE_EVIDENCE_FIXTURES[0];
  const context = await browser.newContext({
    viewport: { width: 620, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(fixture.html, { waitUntil: "load" });
    const sourceStateSha256Before = await sourceStateSha256(page);
    const cdp = await context.newCDPSession(page);
    try {
      const before = await cdp.send("Page.getFrameTree");
      const frameId = before.frameTree.frame.id;
      const loaderId = before.frameTree.frame.loaderId;
      if (!frameId || !loaderId) {
        throw new Error("default-off control frame/loader identity is absent");
      }
      const request = {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: "ReturnAsStream" as const,
      };
      const result = await rawSend(cdp, "Page.printToPDF", request);
      const stream = result.stream;
      if (typeof stream !== "string" || stream === "") {
        throw new Error("default-off print did not return the unopened downstream stream");
      }
      await rawSend(cdp, "IO.close", { handle: stream });
      if (typeof result.data === "string" && result.data.length > 0) {
        throw new Error("default-off stream print unexpectedly returned inline PDF bytes");
      }
      const unexpectedDomotionResponseFields = Object.keys(result)
        .filter((key) => key.startsWith("domotion"));
      const after = await cdp.send("Page.getFrameTree");
      if (after.frameTree.frame.id !== frameId
          || after.frameTree.frame.loaderId !== loaderId) {
        throw new Error("default-off control epoch changed during print");
      }
      const sourceStateSha256After = await sourceStateSha256(page);
      if (sourceStateSha256Before !== sourceStateSha256After) {
        throw new Error("default-off print did not restore browser source state exactly");
      }
      return {
        fixtureId: fixture.id,
        request,
        frameId,
        loaderId,
        sourceStateSha256Before,
        sourceStateSha256After,
        unexpectedDomotionResponseFields,
        sourceRestoredExactly: true,
        pdfBytesReadForLogicalFacts: false,
      };
    } finally {
      await cdp.detach();
    }
  } finally {
    await context.close();
  }
}

async function collectCase(
  browser: Browser,
  browserCdp: CDPSession,
  browserProcessId: number,
  browserExecutableSha256: string,
  fixture: (typeof PAGED_TABLE_EVIDENCE_FIXTURES)[number],
  ordinal: number,
): Promise<PagedTableRendererEvidenceCase> {
  const context = await browser.newContext({
    viewport: { width: 620, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(fixture.html, { waitUntil: "load" });
    const sourceStateSha256Before = await sourceStateSha256(page);
    const cdp = await context.newCDPSession(page);
    try {
      const before = await cdp.send("Page.getFrameTree");
      const frameId = before.frameTree.frame.id;
      const loaderId = before.frameTree.frame.loaderId;
      const documentUrl = before.frameTree.frame.url;
      if (!frameId || !loaderId || !documentUrl) {
        throw new Error("fixture frame/loader/document identity is absent");
      }
      const printRequest: PagedTableRendererPrintRequest = {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: "ReturnAsStream",
        domotionPagedTableEvidence: true,
      };
      const result = await rawSend(cdp, "Page.printToPDF", printRequest);
      const stream = result.stream;
      if (typeof stream !== "string" || stream === "") {
        throw new Error("printToPDF did not return the unopened downstream stream");
      }
      // Close without IO.read: PDF bytes/vector/raster never become logical input.
      await rawSend(cdp, "IO.close", { handle: stream });
      if (typeof result.data === "string" && result.data.length > 0) {
        throw new Error("stream print unexpectedly returned inline PDF bytes");
      }
      const evidence = result.domotionPagedTableEvidence;
      if (typeof evidence !== "string" || evidence === "") {
        throw new Error("patched printToPDF response omitted Blink evidence");
      }
      const sidecarByteLength = Buffer.byteLength(evidence);
      if (sidecarByteLength > PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES) {
        throw new Error("Blink evidence sidecar exceeded its hard response bound");
      }
      const payload = JSON.parse(evidence) as BlinkPagedTableRendererPayload;
      const payloadErrors = validateBlinkPagedTableRendererPayload(payload);
      if (payloadErrors.length > 0) throw new Error(payloadErrors.join("; "));
      const rendererProcessId = Number(result.domotionRendererProcessId);
      const responseBrowserProcessId = Number(result.domotionBrowserProcessId);
      if (responseBrowserProcessId !== browserProcessId) {
        throw new Error("DevTools sidecar browser PID differs from SystemInfo");
      }
      await processId(browserCdp, "renderer", rendererProcessId);
      const rendererExecutablePath = processExecutablePath(rendererProcessId);
      if (rendererExecutablePath !== binaryPath) {
        throw new Error("live renderer does not map the authenticated headless_shell image");
      }
      const rendererExecutableSha256 = browserExecutableSha256;
      if (result.domotionSourceRestoredExactly !== true) {
        throw new Error("PrintEnd did not restore the exact source state token");
      }
      const after = await cdp.send("Page.getFrameTree");
      if (after.frameTree.frame.id !== frameId
          || after.frameTree.frame.loaderId !== loaderId) {
        throw new Error("frame/loader epoch changed during print collection");
      }
      const sourceStateSha256After = await sourceStateSha256(page);
      if (sourceStateSha256Before !== sourceStateSha256After) {
        throw new Error("browser source state did not restore byte-exactly after PrintEnd");
      }
      const printParametersSha256 = pagedTableEvidenceDigest(payload.printParameters);
      const browserVersion = browser.version();
      const browserProtocol = await browserCdp.send("Browser.getVersion");
      const sidecarSha256 = shaBytes(evidence);
      const epochId = pagedTableEvidenceDigest({
        ordinal,
        browserProcessId,
        rendererProcessId,
        rendererExecutablePath,
        rendererExecutableSha256,
        frameId,
        loaderId,
        documentUrl,
        frameToken: payload.frameToken,
        documentToken: payload.documentToken,
        browserVersion,
        protocolVersion: browserProtocol.protocolVersion,
        printRequest,
        printParametersSha256,
        sourceStateSha256: sourceStateSha256Before,
        sidecarSha256,
      });
      const built = buildPagedCollapsedTableRecord({
        sourceRevision: PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION,
        printEpoch: {
          epochId,
          documentLoaderId: loaderId,
          browserVersion,
          protocolVersion: browserProtocol.protocolVersion,
          printParametersSha256,
          lifecycle: "PrintBegin-to-PrintEnd",
          logicalTransport: "blink-private-physical-fragment-tree-v1",
          logicalFactsDerivedFromPdfVectorOrRaster: false,
          sourceRestoredExactly: true,
        },
        pages: payload.pages,
      });
      if (built.status !== "authenticated") {
        throw new Error(`Blink private record rejected: ${built.reason}`);
      }
      return {
        fixtureId: fixture.id,
        matrix: [...fixture.matrix],
        requestOrdinal: ordinal,
        browserProcessId,
        rendererProcessId,
        rendererExecutablePath,
        rendererExecutableSha256,
        frameId,
        loaderId,
        documentUrl,
        documentToken: payload.documentToken,
        frameToken: payload.frameToken,
        printRequest,
        printParameters: payload.printParameters,
        sourceStateSha256Before,
        sourceStateSha256After,
        sidecar: evidence,
        sidecarByteLength,
        sidecarSha256,
        sourceRestoredExactly: true,
        pdfBytesReadForLogicalFacts: false,
        record: built,
      };
    } finally {
      await cdp.detach();
    }
  } finally {
    await context.close();
  }
}

export async function collectPagedTableRendererEvidence(): Promise<PagedTableRendererEvidenceArtifact> {
  console.error("[dm2573] authenticating pinned inputs");
  const sourceFiles = sourceFileHashes();
  const patchSha256 = fileSha(patchPath);
  assertPinnedInputs();
  const browserExecutableSha256 = fileSha(binaryPath);
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath: binaryPath,
      headless: true,
      args: ["--headless=new", "--disable-gpu", "--no-sandbox"],
    });
    console.error("[dm2573] patched browser launched explicitly headless");
    const browserCdp = await browser.newBrowserCDPSession();
    try {
      const browserProcessId = await processId(browserCdp, "browser");
      if (processExecutablePath(browserProcessId) !== binaryPath) {
        throw new Error("live browser does not map the launched authenticated headless_shell image");
      }
      const defaultOffControl = await collectDefaultOffControl(browser);
      console.error("[dm2573] runtime-default-off control complete");
      const cases: PagedTableRendererEvidenceCase[] = [];
      for (let ordinal = 0; ordinal < PAGED_TABLE_EVIDENCE_FIXTURES.length; ordinal++) {
        console.error(`[dm2573] collecting fixture ${ordinal + 1}/${PAGED_TABLE_EVIDENCE_FIXTURES.length}`);
        cases.push(await collectCase(
          browser,
          browserCdp,
          browserProcessId,
          browserExecutableSha256,
          PAGED_TABLE_EVIDENCE_FIXTURES[ordinal],
          ordinal,
        ));
      }
      const seed = cases.find((row) =>
        row.record.pages.some((page) => page.tableOccurrences.some((table) =>
          table.collapsedEdges.length > 1)))?.record;
      if (!seed) throw new Error("renderer corpus has no mutation-capable table record");
      const mutations = runPagedTableRendererHostileMutations(
        seed as AuthenticatedPagedCollapsedTableRecord,
      );
      if (fileSha(binaryPath) !== browserExecutableSha256) {
        throw new Error("authenticated headless_shell changed during collection");
      }
      assertPinnedInputs();
      if (fileSha(patchPath) !== patchSha256
          || pagedTableEvidenceDigest(sourceFileHashes())
            !== pagedTableEvidenceDigest(sourceFiles)) {
        throw new Error("renderer helper source changed during collection");
      }
      const discriminators = {
        everyRecordSourceOwned: cases.every((row) => row.record.status === "authenticated"),
        everySidecarBounded: cases.every((row) => row.sidecarByteLength > 0
          && row.sidecarByteLength <= PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES),
        everyEpochBound: cases.every((row) =>
          row.record.printEpoch.documentLoaderId === row.loaderId),
        everySourceRestored: cases.every((row) => row.sourceRestoredExactly
          && row.sourceStateSha256Before === row.sourceStateSha256After),
        browserRendererImagesAuthenticated: true,
        noPdfVectorRasterLogicalFacts:
          !defaultOffControl.pdfBytesReadForLogicalFacts
          && cases.every((row) => !row.pdfBytesReadForLogicalFacts
            && !row.record.printEpoch.logicalFactsDerivedFromPdfVectorOrRaster),
        runtimeDefaultDisabled:
          defaultOffControl.unexpectedDomotionResponseFields.length === 0
          && defaultOffControl.sourceRestoredExactly,
        allRequiredScenariosCovered: REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX.every(
          (cell) => cases.some((row) =>
            row.matrix.includes(cell) && rendererCaseProvesMatrixCell(row, cell)),
        ),
        allHostileMutationsRejected: mutations.every((row) => row.rejected),
      };
      const pass = Object.values(discriminators).every(Boolean);
      const artifact: PagedTableRendererEvidenceArtifact = {
        schemaVersion: 1,
        ticket: "DM-2573",
        contract: "pinned-blink-private-paged-table-response-sidecar-no-pdf-facts",
        generatedAt: new Date().toISOString(),
        artifactDigest: "",
        helper: {
          abi: PAGED_TABLE_RENDERER_EVIDENCE_ABI,
          maximumSidecarBytes: PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES,
          runtimeDefaultEnabled: false,
          transport: "Page.printToPDF-optional-bounded-response-sidecar",
          capturePhase: "after-PrintBegin-before-PrintEnd",
        },
        build: {
          chromiumRevision: PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION,
          skiaRevision: PAGED_TABLE_RENDERER_EVIDENCE_SKIA_REVISION,
          depotToolsRevision: PAGED_TABLE_RENDERER_EVIDENCE_DEPOT_TOOLS_REVISION,
          sourceRoot,
          patchPath,
          patchSha256,
          sourceFiles,
          sourceDeltaMatchesPatchExactly: true,
          browserExecutablePath: binaryPath,
          browserExecutableSha256,
          rendererExecutablePath: binaryPath,
          rendererExecutableSha256: browserExecutableSha256,
          browserAndRendererUseSamePinnedImage: true,
          explicitlyHeadless: true,
        },
        defaultOffControl,
        cases,
        mutations,
        packaging: pagedTableRendererPlatformPackaging(),
        discriminators,
        verdict: pass ? "pinned-renderer-helper-ready" : "pinned-renderer-helper-incomplete",
        pass,
      };
      artifact.artifactDigest = pagedTableRendererArtifactDigest(artifact);
      const errors = validatePagedTableRendererEvidenceArtifact(artifact);
      if (errors.length > 0) throw new Error(errors.join("; "));
      // Persist before browser teardown: the pinned headless_shell can
      // terminate the invoking process group while Playwright closes it.
      // Evidence must already be durable at that point.
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
      console.error(`[dm2573] retained ${outputPath}`);
      return artifact;
    } finally {
      await browserCdp.detach();
    }
  } catch (error) {
    console.error("[dm2573] collection failed before teardown", error);
    throw error;
  } finally {
    if (browser != null) await closeBrowserSafely(browser);
  }
}

async function main(): Promise<void> {
  const artifact = await collectPagedTableRendererEvidence();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({
    verdict: artifact.verdict,
    cases: artifact.cases.length,
    mutations: artifact.mutations.length,
    explicitlyHeadless: artifact.build.explicitlyHeadless,
    pass: artifact.pass,
  }, null, 2));
}

await main();
