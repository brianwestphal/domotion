/**
 * Versioned manifest contract for opt-in paged-media capture bundles.
 *
 * Chromium 7d859f271c exposes only PDF bytes/a stream through public
 * Page.printToPDF. Authenticated manifests therefore require the separately
 * supplied Blink-private PrintBegin-to-PrintEnd transport; PDF/vector/raster
 * output is never accepted as logical page evidence. See docs/255.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "./paged-collapsed-table-record.js";

export const PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const PAGED_CAPTURE_BUNDLE_ABI = "domotion-paged-capture-bundle-v1" as const;
export const PAGED_CAPTURE_HELPER_ABI = "domotion-paged-capture-combined-v2" as const;
export const PAGED_CAPTURE_SKIA_REVISION =
  "62efacd37737505732dbe3d8daa62abd679626a1" as const;
export const PAGED_CAPTURE_HELPER_PATCH_SHA256 =
  "a94cda690cb1b0b5d78438ed195b8f4b1df161054b9e8172e6fa26500b87bcba" as const;
export const PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256 =
  "c4a8ab1e0c6832a7bbde849e54d26cf9c396adbedec60a7bfba5bb24209b6792" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256");
const positiveFinite = z.number().finite().positive();
const nonNegativeFinite = z.number().finite().nonnegative();
const nonNegativeSafeInteger = z.number().int().safe().nonnegative();
const positiveSafeInteger = z.number().int().safe().positive();
const bundleStemSchema = z.string().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/,
  "expected a filesystem-safe bundle stem",
);
const relativeSvgPathSchema = z.string().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?\.pages\/page-[0-9]{4,}\.svg$/,
  "expected <bundle>.pages/page-NNNN.svg",
);

const sourceSchema = z.strictObject({
  url: z.string().min(1),
  root: z.strictObject({
    selector: z.string().min(1),
    identitySha256: sha256Schema,
  }),
});

const printRequestSchema = z.strictObject({
  paper: z.strictObject({
    widthInches: positiveFinite,
    heightInches: positiveFinite,
    landscape: z.boolean(),
  }),
  marginInches: z.strictObject({
    top: nonNegativeFinite,
    right: nonNegativeFinite,
    bottom: nonNegativeFinite,
    left: nonNegativeFinite,
  }),
  pageRanges: z.string(),
  scale: positiveFinite,
  displayHeaderFooter: z.literal(false),
  printBackground: z.literal(true),
  preferCSSPageSize: z.boolean(),
});

const sourcePinsSchema = z.strictObject({
  chromiumRevision: z.literal(PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION),
  skiaRevision: z.literal(PAGED_CAPTURE_SKIA_REVISION),
  helperAbi: z.literal(PAGED_CAPTURE_HELPER_ABI),
  helperPatchSha256: z.literal(PAGED_CAPTURE_HELPER_PATCH_SHA256),
});

const commonShape = {
  $schema: z.string().optional(),
  schemaVersion: z.literal(PAGED_CAPTURE_BUNDLE_SCHEMA_VERSION),
  abi: z.literal(PAGED_CAPTURE_BUNDLE_ABI),
  bundleStem: bundleStemSchema,
  source: sourceSchema,
  request: printRequestSchema,
  sourcePins: sourcePinsSchema,
};

const pageSchema = z.strictObject({
  selectionIndex: nonNegativeSafeInteger,
  pageIndex: nonNegativeSafeInteger,
  pageNumber: positiveSafeInteger,
  pageName: z.string().min(1).nullable(),
  emptyKind: z.enum(["none", "forced-blank", "terminal-empty"]),
  media: z.literal("print"),
  widthCssPx: positiveFinite,
  heightCssPx: positiveFinite,
  pageRecordSha256: sha256Schema,
  collapsedBorderConsistencySha256: sha256Schema,
  svg: z.strictObject({
    path: relativeSvgPathSchema,
    byteLength: nonNegativeSafeInteger,
    sha256: sha256Schema,
    selfContained: z.literal(true),
  }),
});

const authenticatedManifestSchema = z.strictObject({
  ...commonShape,
  status: z.literal("authenticated"),
  helper: z.strictObject({
    bundleManifestSha256: sha256Schema,
    executableSha256: sha256Schema,
    runtimeDependenciesSha256: sha256Schema,
    browserProcessId: positiveSafeInteger,
    rendererProcessId: positiveSafeInteger,
    browserVersion: z.string().min(1),
    protocolVersion: z.string().min(1),
  }),
  printEpoch: z.strictObject({
    epochId: z.string().min(1),
    frameId: z.string().min(1),
    documentLoaderId: z.string().min(1),
    printParametersSha256: sha256Schema,
    lifecycle: z.literal("PrintBegin-to-PrintEnd"),
    logicalTransport: z.literal("blink-private-paged-capture-physical-fragment-tree-v1"),
    logicalFactsDerivedFromPdfVectorOrRaster: z.literal(false),
    sourceRestoredExactly: z.literal(true),
  }),
  pages: z.array(pageSchema).min(1),
  bundleSha256: sha256Schema,
});

const unavailableReasonSchema = z.enum([
  "stock-chromium",
  "helper-mismatch",
  "sidecar-invalid",
  "page-records-unavailable",
  "source-restoration-failed",
  "unsupported-paint",
]);

const unavailableManifestSchema = z.strictObject({
  ...commonShape,
  status: z.literal("unavailable"),
  reasonCode: unavailableReasonSchema,
  detail: z.string().min(1),
  missingCapabilities: z.array(z.string().min(1)).min(1),
  observedRuntime: z.strictObject({
    product: z.string().min(1),
    revision: z.string().min(1),
    protocolVersion: z.string().min(1),
    helperAbi: z.string().min(1).nullable(),
  }).optional(),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function authenticatedDigestInput(
  manifest: Omit<AuthenticatedPagedCaptureBundleManifest, "bundleSha256">,
): unknown {
  return manifest;
}

export function pagedCaptureBundleDigest(
  manifest: Omit<AuthenticatedPagedCaptureBundleManifest, "bundleSha256">,
): string {
  return sha256(canonicalJson(authenticatedDigestInput(manifest)));
}

export const pagedCaptureBundleManifestSchema = z.discriminatedUnion("status", [
  authenticatedManifestSchema,
  unavailableManifestSchema,
]).superRefine((manifest, context) => {
  if (manifest.status === "unavailable") {
    if (new Set(manifest.missingCapabilities).size !== manifest.missingCapabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["missingCapabilities"],
        message: "missing capabilities must be unique",
      });
    }
    return;
  }

  const seenPaths = new Set<string>();
  for (let index = 0; index < manifest.pages.length; index++) {
    const page = manifest.pages[index];
    if (page.selectionIndex !== index) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "selectionIndex"],
        message: `expected consecutive selection index ${index}`,
      });
    }
    if (index > 0 && page.pageIndex <= manifest.pages[index - 1].pageIndex) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "pageIndex"],
        message: "source page indices must be strictly increasing",
      });
    }
    if (page.pageNumber !== page.pageIndex + 1) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "pageNumber"],
        message: "pageNumber must be pageIndex + 1",
      });
    }
    const expectedPath = `${manifest.bundleStem}.pages/page-${String(page.pageNumber).padStart(4, "0")}.svg`;
    if (page.svg.path !== expectedPath) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "svg", "path"],
        message: `expected deterministic page path ${expectedPath}`,
      });
    }
    if (seenPaths.has(page.svg.path)) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "svg", "path"],
        message: "page SVG paths must be unique",
      });
    }
    seenPaths.add(page.svg.path);
  }

  const { bundleSha256: _bundleSha256, ...digestInput } = manifest;
  if (manifest.bundleSha256 !== pagedCaptureBundleDigest(digestInput)) {
    context.addIssue({
      code: "custom",
      path: ["bundleSha256"],
      message: "bundle digest does not match authenticated manifest content",
    });
  }
});

export type PagedCaptureBundleManifest = z.infer<typeof pagedCaptureBundleManifestSchema>;
export type AuthenticatedPagedCaptureBundleManifest = z.infer<typeof authenticatedManifestSchema>;
export type UnavailablePagedCaptureBundleManifest = z.infer<typeof unavailableManifestSchema>;
export type AuthenticatedPagedCaptureBundleInput = Omit<
  AuthenticatedPagedCaptureBundleManifest,
  "bundleSha256"
>;

export function buildAuthenticatedPagedCaptureBundleManifest(
  input: AuthenticatedPagedCaptureBundleInput,
): AuthenticatedPagedCaptureBundleManifest {
  return pagedCaptureBundleManifestSchema.parse({
    ...input,
    bundleSha256: pagedCaptureBundleDigest(input),
  }) as AuthenticatedPagedCaptureBundleManifest;
}

export function parsePagedCaptureBundleManifest(input: unknown): PagedCaptureBundleManifest {
  return pagedCaptureBundleManifestSchema.parse(input);
}

export interface PagedCaptureBundleAssetReader {
  (relativePath: string): Uint8Array | string | null | undefined
    | Promise<Uint8Array | string | null | undefined>;
}

function externalSvgReferences(svg: string): string[] {
  const references: string[] = [];
  const inertRasterData = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
  for (const match of svg.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gis)) {
    const value = match[2].trim();
    if (value !== "" && !value.startsWith("#") && !inertRasterData.test(value)) {
      references.push(value);
    }
  }
  for (const match of svg.matchAll(/\burl\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    const value = match[2].trim();
    if (value !== "" && !value.startsWith("#") && !inertRasterData.test(value)) {
      references.push(value);
    }
  }
  if (/\@import\b/i.test(svg)) references.push("@import");
  if (/<(?:script|foreignObject)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)) {
    references.push("active-content");
  }
  return references;
}

/** Verify that every declared SVG exists, re-hashes, and is self-contained. */
export async function verifyPagedCaptureBundleAssets(
  input: unknown,
  readAsset: PagedCaptureBundleAssetReader,
): Promise<string[]> {
  const parsed = pagedCaptureBundleManifestSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`);
  }
  if (parsed.data.status === "unavailable") return [];

  const errors: string[] = [];
  for (const page of parsed.data.pages) {
    let asset: Uint8Array | string | null | undefined;
    try {
      asset = await readAsset(page.svg.path);
    } catch (error) {
      errors.push(`${page.svg.path}: asset read failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (asset == null) {
      errors.push(`${page.svg.path}: declared page SVG is missing`);
      continue;
    }
    const bytes = typeof asset === "string" ? Buffer.from(asset, "utf8") : asset;
    if (bytes.byteLength !== page.svg.byteLength) {
      errors.push(`${page.svg.path}: byte length mismatch`);
    }
    if (sha256(bytes) !== page.svg.sha256) {
      errors.push(`${page.svg.path}: SHA-256 mismatch`);
    }
    const svg = typeof asset === "string" ? asset : Buffer.from(asset).toString("utf8");
    if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/i.test(svg)) {
      errors.push(`${page.svg.path}: asset is not an SVG document`);
    }
    const external = externalSvgReferences(svg);
    if (external.length > 0) {
      errors.push(`${page.svg.path}: external runtime references are forbidden (${external.join(", ")})`);
    }
  }
  return errors;
}
