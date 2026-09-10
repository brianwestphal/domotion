import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { Page } from "@playwright/test";

import {
  PAGED_CAPTURE_BUNDLE_ABI,
  PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
  PAGED_CAPTURE_HELPER_ABI,
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
  buildAuthenticatedPagedCaptureBundleManifest,
  verifyPagedCaptureBundleAssets,
  type AuthenticatedPagedCaptureBundleManifest,
} from "./paged-capture-bundle.js";
import { PAGED_CAPTURE_BUNDLE_SCHEMA_ID } from "./paged-capture-bundle-json-schema.js";
import {
  PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
  launchPagedCaptureHelper,
  pagedCaptureHelperRuntimeDependenciesDigest,
} from "./paged-capture-helper.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "./paged-collapsed-table-record.js";
import { captureAuthenticatedPagedPageRecord } from "./paged-page-record.js";
import {
  renderAuthenticatedPagedSvgPages,
  type RenderedPagedSvgPage,
} from "../render/paged-page-svg.js";

const OUTPUT_SUFFIX = ".domotion-pages.json";
const SHA256 = /^[0-9a-f]{64}$/;

export interface PagedCapturePrintOptions {
  paperWidthInches?: number;
  paperHeightInches?: number;
  landscape?: boolean;
  marginTopInches?: number;
  marginRightInches?: number;
  marginBottomInches?: number;
  marginLeftInches?: number;
  pageRanges?: string;
  scale?: number;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
}

export interface CapturePagedSvgBundleOptions {
  helperManifestPath: string;
  expectedHelperManifestSha256: string;
  outputManifestPath: string;
  /** Load and settle the target document in the authenticated helper page. */
  preparePage(page: Page): Promise<void>;
  sourceSelector?: string;
  print?: PagedCapturePrintOptions;
}

export interface WritePagedCaptureBundleOptions {
  outputManifestPath: string;
  manifest: AuthenticatedPagedCaptureBundleManifest;
  pages: readonly RenderedPagedSvgPage[];
}

export class PagedCaptureError extends Error {
  readonly code:
    | "invalid-options"
    | "helper-authentication"
    | "source-identity"
    | "capture-unavailable"
    | "bundle-conflict"
    | "bundle-write";

  constructor(code: PagedCaptureError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PagedCaptureError";
    this.code = code;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PagedCaptureError("invalid-options", `${label} must be a positive finite number`);
  }
  return value;
}

function finiteNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new PagedCaptureError("invalid-options", `${label} must be a non-negative finite number`);
  }
  return value;
}

/** Normalize Chromium's closed page-range grammar without expanding ranges. */
export function normalizePagedPageRanges(input = ""): string {
  const compact = input.replace(/\s+/g, "");
  if (compact === "") return "";
  const parts = compact.split(",");
  if (parts.length > 256 || parts.some((part) => !/^\d+(?:-\d+)?$/.test(part))) {
    throw new PagedCaptureError(
      "invalid-options",
      'pageRanges must use comma-separated positive pages or closed ranges (for example "1-3,7")',
    );
  }
  for (const part of parts) {
    const [startText, endText = startText] = part.split("-");
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 1 || end < start || end > 1_000_000) {
      throw new PagedCaptureError("invalid-options", `invalid page range "${part}"`);
    }
  }
  return parts.join(",");
}

function pageRangesContain(pageRanges: string, pageNumber: number): boolean {
  if (pageRanges === "") return true;
  return pageRanges.split(",").some((part) => {
    const [startText, endText = startText] = part.split("-");
    return pageNumber >= Number(startText) && pageNumber <= Number(endText);
  });
}

function outputIdentity(outputManifestPath: string): {
  manifestPath: string;
  parent: string;
  bundleStem: string;
  pagesPath: string;
} {
  const manifestPath = resolve(outputManifestPath);
  const name = basename(manifestPath);
  if (!name.endsWith(OUTPUT_SUFFIX)) {
    throw new PagedCaptureError(
      "invalid-options",
      `output manifest must end in ${OUTPUT_SUFFIX}`,
    );
  }
  const bundleStem = name.slice(0, -OUTPUT_SUFFIX.length);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(bundleStem)) {
    throw new PagedCaptureError("invalid-options", "output manifest has an unsafe bundle stem");
  }
  const parent = dirname(manifestPath);
  return { manifestPath, parent, bundleStem, pagesPath: join(parent, `${bundleStem}.pages`) };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Write page assets first and atomically publish the manifest as the commit point. */
export async function writeAuthenticatedPagedCaptureBundle(
  options: WritePagedCaptureBundleOptions,
): Promise<void> {
  const output = outputIdentity(options.outputManifestPath);
  if (options.manifest.bundleStem !== output.bundleStem) {
    throw new PagedCaptureError("invalid-options", "manifest bundleStem differs from the output filename");
  }
  if (options.pages.length !== options.manifest.pages.length
      || options.pages.some((page, index) =>
        page.pageIndex !== options.manifest.pages[index]?.pageIndex
        || page.svgSha256 !== options.manifest.pages[index]?.svg.sha256
        || page.svgByteLength !== options.manifest.pages[index]?.svg.byteLength)) {
    throw new PagedCaptureError("invalid-options", "rendered pages differ from the approved manifest");
  }
  await mkdir(output.parent, { recursive: true });
  if (await pathExists(output.manifestPath) || await pathExists(output.pagesPath)) {
    throw new PagedCaptureError("bundle-conflict", "paged bundle output already exists; choose a new manifest path");
  }

  const nonce = randomUUID();
  const stagedPages = join(output.parent, `.${output.bundleStem}.pages.tmp-${nonce}`);
  const stagedManifest = join(output.parent, `.${output.bundleStem}.manifest.tmp-${nonce}`);
  let pagesRenamed = false;
  try {
    await mkdir(stagedPages, { recursive: false });
    for (const page of options.pages) {
      await writeFile(join(stagedPages, `page-${String(page.pageNumber).padStart(4, "0")}.svg`), page.svg, { flag: "wx" });
    }
    const assetErrors = await verifyPagedCaptureBundleAssets(options.manifest, async (relativePath) => {
      const prefix = `${output.bundleStem}.pages/`;
      if (!relativePath.startsWith(prefix)) return null;
      return readFile(join(stagedPages, relativePath.slice(prefix.length)));
    });
    if (assetErrors.length > 0) {
      throw new PagedCaptureError("bundle-write", `staged paged bundle failed verification: ${assetErrors.join("; ")}`);
    }
    await writeFile(stagedManifest, `${JSON.stringify(options.manifest, null, 2)}\n`, { flag: "wx" });
    await rename(stagedPages, output.pagesPath);
    pagesRenamed = true;
    // A hard link is an atomic, no-overwrite commit of the already-complete
    // sibling file. Consumers cannot observe a manifest before every SVG.
    await link(stagedManifest, output.manifestPath);
    await unlink(stagedManifest);
  } catch (error) {
    await rm(stagedPages, { recursive: true, force: true }).catch(() => undefined);
    await rm(stagedManifest, { force: true }).catch(() => undefined);
    if (pagesRenamed) await rm(output.pagesPath, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof PagedCaptureError) throw error;
    throw new PagedCaptureError("bundle-write", `failed to publish paged bundle: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function captureSourceIdentity(page: Page, selector: string): Promise<{
  url: string;
  root: { selector: string; identitySha256: string };
}> {
  let facts;
  try {
    facts = await page.evaluate((sourceSelector) => {
      const matches = document.querySelectorAll(sourceSelector);
      if (matches.length !== 1) return { count: matches.length };
      const element = matches[0] as Element;
      const computed = getComputedStyle(element);
      return {
        count: 1,
        url: document.URL,
        outerHTML: element.outerHTML,
        computed: Array.from(computed, (name) => [name, computed.getPropertyValue(name)]),
      };
    }, selector);
  } catch (error) {
    throw new PagedCaptureError(
      "source-identity",
      `could not inspect source selector ${JSON.stringify(selector)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (facts.count !== 1 || typeof facts.url !== "string"
      || typeof facts.outerHTML !== "string" || !Array.isArray(facts.computed)) {
    throw new PagedCaptureError("source-identity", `source selector must match exactly one element; matched ${facts.count}`);
  }
  const serialized = JSON.stringify({ selector, outerHTML: facts.outerHTML, computed: facts.computed });
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) {
    throw new PagedCaptureError("source-identity", "source root identity exceeded its 8 MiB bound");
  }
  return { url: facts.url, root: { selector, identitySha256: sha256(serialized) } };
}

/** Launch the caller-pinned helper, capture print pages, and publish one bundle. */
export async function capturePagedSvgBundle(
  options: CapturePagedSvgBundleOptions,
): Promise<AuthenticatedPagedCaptureBundleManifest> {
  if (!SHA256.test(options.expectedHelperManifestSha256)) {
    throw new PagedCaptureError("invalid-options", "expected helper manifest SHA-256 must be lowercase hexadecimal");
  }
  const output = outputIdentity(options.outputManifestPath);
  const request = {
    paper: {
      widthInches: finitePositive(options.print?.paperWidthInches ?? 8.5, "paper width"),
      heightInches: finitePositive(options.print?.paperHeightInches ?? 11, "paper height"),
      landscape: options.print?.landscape ?? false,
    },
    marginInches: {
      top: finiteNonnegative(options.print?.marginTopInches ?? 0.4, "top margin"),
      right: finiteNonnegative(options.print?.marginRightInches ?? 0.4, "right margin"),
      bottom: finiteNonnegative(options.print?.marginBottomInches ?? 0.4, "bottom margin"),
      left: finiteNonnegative(options.print?.marginLeftInches ?? 0.4, "left margin"),
    },
    pageRanges: normalizePagedPageRanges(options.print?.pageRanges),
    scale: finitePositive(options.print?.scale ?? 1, "print scale"),
    displayHeaderFooter: false as const,
    printBackground: options.print?.printBackground ?? true,
    preferCSSPageSize: options.print?.preferCSSPageSize ?? false,
  };
  const selector = options.sourceSelector ?? "html";
  if (selector.trim() === "") throw new PagedCaptureError("invalid-options", "sourceSelector must not be empty");

  let launched;
  try {
    launched = await launchPagedCaptureHelper({
      manifestPath: options.helperManifestPath,
      expectedManifestSha256: options.expectedHelperManifestSha256,
      capability: PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
    });
  } catch (error) {
    throw new PagedCaptureError("helper-authentication", `paged helper authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    const context = await launched.browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await options.preparePage(page);
    const source = await captureSourceIdentity(page, selector);
    const record = await captureAuthenticatedPagedPageRecord(launched, page, {
      landscape: request.paper.landscape,
      printBackground: request.printBackground,
      scale: request.scale,
      paperWidth: request.paper.widthInches,
      paperHeight: request.paper.heightInches,
      marginTop: request.marginInches.top,
      marginRight: request.marginInches.right,
      marginBottom: request.marginInches.bottom,
      marginLeft: request.marginInches.left,
      pageRanges: request.pageRanges,
      preferCSSPageSize: request.preferCSSPageSize,
    });
    if (record.status !== "authenticated") {
      throw new PagedCaptureError("capture-unavailable", `paged capture unavailable (${record.reason}): ${record.detail}`);
    }
    const pages = renderAuthenticatedPagedSvgPages(record);
    const unexpectedPage = pages.find((page) =>
      !pageRangesContain(request.pageRanges, page.pageNumber));
    if (unexpectedPage) {
      throw new PagedCaptureError(
        "capture-unavailable",
        `helper returned page ${unexpectedPage.pageNumber} outside requested pageRanges ${JSON.stringify(request.pageRanges)}`,
      );
    }
    const executable = launched.helper.manifest.members.find((member) =>
      member.path === launched.helper.manifest.runtime.executablePath && member.role === "executable");
    if (!executable) throw new PagedCaptureError("helper-authentication", "verified helper executable member disappeared");
    const manifest = buildAuthenticatedPagedCaptureBundleManifest({
      $schema: PAGED_CAPTURE_BUNDLE_SCHEMA_ID,
      schemaVersion: PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
      abi: PAGED_CAPTURE_BUNDLE_ABI,
      bundleStem: output.bundleStem,
      status: "authenticated",
      source,
      request,
      sourcePins: {
        chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
        skiaRevision: PAGED_CAPTURE_SKIA_REVISION,
        helperAbi: PAGED_CAPTURE_HELPER_ABI,
        helperPatchSha256: PAGED_CAPTURE_HELPER_PATCH_SHA256,
      },
      helper: {
        bundleManifestSha256: launched.helper.manifestSha256,
        executableSha256: executable.sha256,
        runtimeDependenciesSha256: pagedCaptureHelperRuntimeDependenciesDigest(launched.helper.manifest.members),
        browserProcessId: record.document.browserProcessId,
        rendererProcessId: record.document.rendererProcessId,
        browserVersion: record.document.browserVersion,
        protocolVersion: record.document.protocolVersion,
      },
      printEpoch: {
        epochId: record.document.printEpochId,
        frameId: record.document.frameId,
        documentLoaderId: record.document.loaderId,
        printParametersSha256: record.document.printParametersSha256,
        lifecycle: "PrintBegin-to-PrintEnd",
        logicalTransport: "blink-private-paged-capture-physical-fragment-tree-v1",
        logicalFactsDerivedFromPdfVectorOrRaster: false,
        sourceRestoredExactly: true,
      },
      pages: pages.map((page) => ({
        selectionIndex: page.selectionIndex,
        pageIndex: page.pageIndex,
        pageNumber: page.pageNumber,
        pageName: page.pageName,
        emptyKind: page.emptyKind,
        media: "print",
        widthCssPx: page.widthCssPx,
        heightCssPx: page.heightCssPx,
        pageRecordSha256: page.pageRecordSha256,
        collapsedBorderConsistencySha256: page.collapsedBorderConsistencySha256,
        svg: {
          path: `${output.bundleStem}.pages/page-${String(page.pageNumber).padStart(4, "0")}.svg`,
          byteLength: page.svgByteLength,
          sha256: page.svgSha256,
          selfContained: true,
        },
      })),
    });
    await writeAuthenticatedPagedCaptureBundle({ outputManifestPath: output.manifestPath, manifest, pages });
    return manifest;
  } catch (error) {
    if (error instanceof PagedCaptureError) throw error;
    throw new PagedCaptureError(
      "capture-unavailable",
      `paged capture failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await launched.browser.close().catch(() => undefined);
  }
}
