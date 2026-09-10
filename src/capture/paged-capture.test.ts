import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PAGED_CAPTURE_BUNDLE_ABI,
  PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
  PAGED_CAPTURE_HELPER_ABI,
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
  buildAuthenticatedPagedCaptureBundleManifest,
} from "./paged-capture-bundle.js";
import {
  PagedCaptureError,
  normalizePagedPageRanges,
  writeAuthenticatedPagedCaptureBundle,
} from "./paged-capture.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "./paged-collapsed-table-record.js";
import type { RenderedPagedSvgPage } from "../render/paged-page-svg.js";

const temporaryRoots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const svg = '<svg width="120" height="90" viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function page(): RenderedPagedSvgPage {
  return {
    selectionIndex: 0, pageIndex: 2, pageNumber: 3, pageName: "chapter", emptyKind: "none",
    widthCssPx: 120, heightCssPx: 90, svg, svgByteLength: Buffer.byteLength(svg),
    svgSha256: hash(svg), pageRecordSha256: hash("page-record"), collapsedBorderRectCount: 0,
    collapsedBorderConsistencySha256: hash("collapsed"),
  };
}

function manifest() {
  const rendered = page();
  return buildAuthenticatedPagedCaptureBundleManifest({
    schemaVersion: PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
    abi: PAGED_CAPTURE_BUNDLE_ABI,
    bundleStem: "report",
    status: "authenticated",
    source: { url: "https://example.test/", root: { selector: "html", identitySha256: hash("root") } },
    request: {
      paper: { widthInches: 8.5, heightInches: 11, landscape: false },
      marginInches: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 },
      pageRanges: "3", scale: 1, displayHeaderFooter: false,
      printBackground: false, preferCSSPageSize: true,
    },
    sourcePins: {
      chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      skiaRevision: PAGED_CAPTURE_SKIA_REVISION,
      helperAbi: PAGED_CAPTURE_HELPER_ABI,
      helperPatchSha256: PAGED_CAPTURE_HELPER_PATCH_SHA256,
    },
    helper: {
      bundleManifestSha256: hash("manifest"), executableSha256: hash("exe"),
      runtimeDependenciesSha256: hash("deps"), browserProcessId: 10, rendererProcessId: 20,
      browserVersion: "HeadlessChrome/140.0.0.0", protocolVersion: "1.3",
    },
    printEpoch: {
      epochId: "epoch", frameId: "frame", documentLoaderId: "loader",
      printParametersSha256: hash("params"), lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-paged-capture-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false, sourceRestoredExactly: true,
    },
    pages: [{
      selectionIndex: 0, pageIndex: 2, pageNumber: 3, pageName: "chapter", emptyKind: "none",
      media: "print", widthCssPx: 120, heightCssPx: 90,
      pageRecordSha256: rendered.pageRecordSha256,
      collapsedBorderConsistencySha256: rendered.collapsedBorderConsistencySha256,
      svg: { path: "report.pages/page-0003.svg", byteLength: rendered.svgByteLength,
        sha256: rendered.svgSha256, selfContained: true },
    }],
  });
}

describe("paged capture public bundle writer", () => {
  it("normalizes only bounded closed one-based page ranges", () => {
    expect(normalizePagedPageRanges(" 1 - 3, 7 ")).toBe("1-3,7");
    expect(normalizePagedPageRanges()).toBe("");
    for (const invalid of ["0", "3-1", "1-", "-4", "all", "1,,2", "1000001"]) {
      expect(() => normalizePagedPageRanges(invalid)).toThrow(PagedCaptureError);
    }
  });

  it("publishes verified page assets before the atomic manifest commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "domotion-paged-output-"));
    temporaryRoots.push(root);
    const outputManifestPath = join(root, "report.domotion-pages.json");
    const approved = manifest();
    await writeAuthenticatedPagedCaptureBundle({ outputManifestPath, manifest: approved, pages: [page()] });
    expect(await readFile(join(root, "report.pages/page-0003.svg"), "utf8")).toBe(svg);
    expect(JSON.parse(await readFile(outputManifestPath, "utf8"))).toEqual(approved);
    await expect(writeAuthenticatedPagedCaptureBundle({
      outputManifestPath, manifest: approved, pages: [page()],
    })).rejects.toMatchObject({ code: "bundle-conflict" });
  });

  it("rejects page bytes that differ from the approved manifest before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "domotion-paged-output-"));
    temporaryRoots.push(root);
    const mismatched = page();
    mismatched.svg += " ";
    await expect(writeAuthenticatedPagedCaptureBundle({
      outputManifestPath: join(root, "report.domotion-pages.json"),
      manifest: manifest(), pages: [mismatched],
    })).rejects.toMatchObject({ code: "bundle-write" });
    await expect(access(join(root, "report.domotion-pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "report.pages"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
