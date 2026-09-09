import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PAGED_CAPTURE_BUNDLE_ABI,
  PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
  PAGED_CAPTURE_HELPER_ABI,
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
  buildAuthenticatedPagedCaptureBundleManifest,
  pagedCaptureBundleManifestSchema,
  parsePagedCaptureBundleManifest,
  verifyPagedCaptureBundleAssets,
  type AuthenticatedPagedCaptureBundleInput,
  type AuthenticatedPagedCaptureBundleManifest,
} from "./paged-capture-bundle.js";
import {
  PAGED_CAPTURE_BUNDLE_SCHEMA_ID,
  buildPagedCaptureBundleJsonSchema,
  pagedCaptureBundleJsonSchemaText,
} from "./paged-capture-bundle-json-schema.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "./paged-collapsed-table-record.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = resolve(root, "schemas/paged-capture-bundle.schema.json");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const svg1 = '<svg xmlns="http://www.w3.org/2000/svg" width="816" height="1056"><path d="M0 0h1v1z"/></svg>';
const svg2 = '<svg xmlns="http://www.w3.org/2000/svg" width="816" height="1056"><image href="data:image/png;base64,AA=="/></svg>';

function authenticatedInput(): AuthenticatedPagedCaptureBundleInput {
  return {
    schemaVersion: PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
    abi: PAGED_CAPTURE_BUNDLE_ABI,
    bundleStem: "report",
    status: "authenticated",
    source: {
      url: "https://example.test/report",
      root: { selector: "body", identitySha256: hash("body") },
    },
    request: {
      paper: { widthInches: 8.5, heightInches: 11, landscape: false },
      marginInches: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 },
      pageRanges: "",
      scale: 1,
      displayHeaderFooter: false,
      printBackground: true,
      preferCSSPageSize: true,
    },
    sourcePins: {
      chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      skiaRevision: PAGED_CAPTURE_SKIA_REVISION,
      helperAbi: PAGED_CAPTURE_HELPER_ABI,
      helperPatchSha256: PAGED_CAPTURE_HELPER_PATCH_SHA256,
    },
    helper: {
      bundleManifestSha256: hash("helper bundle"),
      executableSha256: hash("executable"),
      runtimeDependenciesSha256: hash("runtime deps"),
      browserProcessId: 101,
      rendererProcessId: 102,
      browserVersion: "HeadlessChrome/140.0.0.0",
      protocolVersion: "1.3",
    },
    printEpoch: {
      epochId: "epoch-1",
      frameId: "frame-1",
      documentLoaderId: "loader-1",
      printParametersSha256: hash("effective print parameters"),
      lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-paged-capture-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      sourceRestoredExactly: true,
    },
    pages: [
      {
        pageIndex: 0,
        pageNumber: 1,
        pageName: null,
        emptyKind: "none",
        media: "print",
        widthCssPx: 816,
        heightCssPx: 1056,
        pageRecordSha256: hash("page record 1"),
        svg: {
          path: "report.pages/page-0001.svg",
          byteLength: Buffer.byteLength(svg1),
          sha256: hash(svg1),
          selfContained: true,
        },
      },
      {
        pageIndex: 1,
        pageNumber: 2,
        pageName: "appendix",
        emptyKind: "none",
        media: "print",
        widthCssPx: 816,
        heightCssPx: 1056,
        pageRecordSha256: hash("page record 2"),
        svg: {
          path: "report.pages/page-0002.svg",
          byteLength: Buffer.byteLength(svg2),
          sha256: hash(svg2),
          selfContained: true,
        },
      },
    ],
  };
}

function authenticated(): AuthenticatedPagedCaptureBundleManifest {
  return buildAuthenticatedPagedCaptureBundleManifest(authenticatedInput());
}

describe("paged-capture bundle manifest", () => {
  it("builds a deterministic authenticated manifest and validates it", () => {
    const first = authenticated();
    const second = buildAuthenticatedPagedCaptureBundleManifest(structuredClone(authenticatedInput()));
    expect(first.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.bundleSha256).toBe(first.bundleSha256);
    expect(parsePagedCaptureBundleManifest(first)).toEqual(first);
  });

  it.each([
    ["path traversal", (value: AuthenticatedPagedCaptureBundleManifest) => { value.pages[0].svg.path = "../page.svg"; }],
    ["nonconsecutive page", (value: AuthenticatedPagedCaptureBundleManifest) => { value.pages[1].pageIndex = 3; }],
    ["wrong human page number", (value: AuthenticatedPagedCaptureBundleManifest) => { value.pages[1].pageNumber = 3; }],
    ["content digest drift", (value: AuthenticatedPagedCaptureBundleManifest) => { value.pages[0].widthCssPx = 612; }],
    ["source mismatch", (value: AuthenticatedPagedCaptureBundleManifest) => { (value.sourcePins as { chromiumRevision: string }).chromiumRevision = "0".repeat(40); }],
    ["PDF-derived logical claim", (value: AuthenticatedPagedCaptureBundleManifest) => { (value.printEpoch as { logicalFactsDerivedFromPdfVectorOrRaster: boolean }).logicalFactsDerivedFromPdfVectorOrRaster = true; }],
    ["failed source restoration", (value: AuthenticatedPagedCaptureBundleManifest) => { (value.printEpoch as { sourceRestoredExactly: boolean }).sourceRestoredExactly = false; }],
    ["unknown field", (value: AuthenticatedPagedCaptureBundleManifest) => { (value as unknown as Record<string, unknown>).pdf = "forbidden"; }],
  ])("rejects %s", (_name, mutate) => {
    const value = structuredClone(authenticated());
    mutate(value);
    expect(pagedCaptureBundleManifestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a fact-free unavailable result and rejects duplicate missing capabilities", () => {
    const unavailable = {
      schemaVersion: PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
      abi: PAGED_CAPTURE_BUNDLE_ABI,
      bundleStem: "report",
      status: "unavailable" as const,
      source: {
        url: "https://example.test/report",
        root: { selector: "body", identitySha256: hash("body") },
      },
      request: authenticatedInput().request,
      sourcePins: authenticatedInput().sourcePins,
      reasonCode: "stock-chromium" as const,
      detail: "public Page.printToPDF exposes no physical fragment sidecar",
      missingCapabilities: ["page-local-physical-fragments"],
    };
    expect(parsePagedCaptureBundleManifest(unavailable)).toEqual(unavailable);
    expect(pagedCaptureBundleManifestSchema.safeParse({
      ...unavailable,
      missingCapabilities: ["page-local-physical-fragments", "page-local-physical-fragments"],
    }).success).toBe(false);
    expect(pagedCaptureBundleManifestSchema.safeParse({ ...unavailable, pages: [] }).success).toBe(false);
  });

  it("verifies page presence, bytes, hashes, SVG shape, and self-containment", async () => {
    const manifest = authenticated();
    const assets = new Map<string, string>([
      [manifest.pages[0].svg.path, svg1],
      [manifest.pages[1].svg.path, svg2],
    ]);
    expect(await verifyPagedCaptureBundleAssets(manifest, (path) => assets.get(path))).toEqual([]);

    assets.delete(manifest.pages[1].svg.path);
    expect(await verifyPagedCaptureBundleAssets(manifest, (path) => assets.get(path)))
      .toContain("report.pages/page-0002.svg: declared page SVG is missing");

    assets.set(manifest.pages[1].svg.path, '<svg><image href="https://example.test/live.png"/></svg>');
    const errors = await verifyPagedCaptureBundleAssets(manifest, (path) => assets.get(path));
    expect(errors).toContain("report.pages/page-0002.svg: byte length mismatch");
    expect(errors).toContain("report.pages/page-0002.svg: SHA-256 mismatch");
    expect(errors).toContain(
      "report.pages/page-0002.svg: external runtime references are forbidden (https://example.test/live.png)",
    );
  });

  it("keeps unavailable manifests asset-free", async () => {
    const unavailable = {
      schemaVersion: PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION,
      abi: PAGED_CAPTURE_BUNDLE_ABI,
      bundleStem: "report",
      status: "unavailable" as const,
      source: authenticatedInput().source,
      request: authenticatedInput().request,
      sourcePins: authenticatedInput().sourcePins,
      reasonCode: "page-records-unavailable" as const,
      detail: "the helper returned no complete page-local paint records",
      missingCapabilities: ["page-local-paint-records"],
    };
    let reads = 0;
    expect(await verifyPagedCaptureBundleAssets(unavailable, () => { reads++; return null; })).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("paged-capture bundle JSON Schema", () => {
  it("keeps the committed schema synchronized with the zod source", () => {
    expect(readFileSync(schemaPath, "utf8")).toBe(pagedCaptureBundleJsonSchemaText());
  });

  it("publishes the stable identity and authenticated/unavailable branches", () => {
    const schema = buildPagedCaptureBundleJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(PAGED_CAPTURE_BUNDLE_SCHEMA_ID);
    expect(JSON.stringify(schema)).toContain('"authenticated"');
    expect(JSON.stringify(schema)).toContain('"unavailable"');
    expect(JSON.stringify(schema)).toContain('"bundleSha256"');
  });
});
