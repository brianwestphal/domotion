import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";

import {
  PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_VERSION,
  PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION,
  PAGED_CAPTURE_HELPER_MAX_SIDECAR_BYTES,
  PAGED_CAPTURE_HELPER_RUNTIME_ABI,
  PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
  PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY,
  PAGED_CAPTURE_HELPER_TRANSPORT_ABI,
  PAGED_CAPTURE_HELPER_TABLE_TRANSPORT_ABI,
  authenticatePagedCaptureHelperProcessesForTest,
  authenticatePagedCaptureHelperTransportForTest,
  pagedCaptureHelperLaunchEnvironmentForTest,
  pagedCaptureHelperRuntimeDependenciesDigest,
  parsePagedCaptureHelperBundleManifest,
  verifyPagedCaptureHelperBundleForTest,
  type PagedCaptureHelperBundleManifest,
  type PagedCaptureHelperBundleMember,
} from "./paged-capture-helper.js";
import {
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
} from "./paged-capture-bundle.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "./paged-collapsed-table-record.js";
import {
  PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_ID,
  buildPagedCaptureHelperBundleJsonSchema,
  pagedCaptureHelperBundleJsonSchemaText,
} from "./paged-capture-helper-json-schema.js";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const temporaryRoots: string[] = [];

const authenticatedProcessImage = (reportedPath: string) => async () => ({
  reportedPath,
  identity: async () => ({
    sha256: sha256("authenticated executable"),
    byteLength: Buffer.byteLength("authenticated executable"),
  }),
  close: async () => undefined,
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  manifestPath: string;
  manifestSha256: string;
  executablePath: string;
  runtimePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "domotion-paged-helper-"));
  temporaryRoots.push(root);
  const executablePath = join(root, "headless_shell");
  const runtimePath = join(root, "runtime.bin");
  const licensePath = join(root, "LICENSE");
  await writeFile(executablePath, "authenticated executable");
  await writeFile(runtimePath, "authenticated runtime dependency");
  await writeFile(licensePath, "license text");
  await chmod(executablePath, 0o755);
  await chmod(runtimePath, 0o644);
  await chmod(licensePath, 0o644);

  const members: PagedCaptureHelperBundleMember[] = [
    { kind: "file", path: "LICENSE", role: "license", byteLength: 12, sha256: sha256("license text"), mode: 0o644 },
    { kind: "file", path: "headless_shell", role: "executable", byteLength: 24, sha256: sha256("authenticated executable"), mode: 0o755 },
    { kind: "file", path: "runtime.bin", role: "runtime-dependency", byteLength: 32, sha256: sha256("authenticated runtime dependency"), mode: 0o644 },
  ];
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`unsupported test architecture ${process.arch}`);
  }
  const platform: PagedCaptureHelperBundleManifest["platform"] = process.platform === "darwin"
    ? {
      os: "darwin",
      architecture: process.arch,
      minimumVersion: "13.0",
      codeSignatureIdentity: "unsigned-ad-hoc",
      quarantineState: "absent",
    }
    : process.platform === "win32"
      ? {
        os: "win32",
        architecture: process.arch,
        minimumBuild: "19045",
        authenticodeIdentity: "unsigned-local-build",
        dllClosureSha256: sha256("DLL closure"),
      }
      : {
        os: "linux",
        architecture: process.arch,
        glibcMinimum: "2.31",
        sandboxMode: "user-namespace",
        dtNeededSha256: sha256("DT_NEEDED closure"),
      };
  const manifest: PagedCaptureHelperBundleManifest = {
    schemaVersion: PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_VERSION,
    runtimeAbi: PAGED_CAPTURE_HELPER_RUNTIME_ABI,
    transportAbi: PAGED_CAPTURE_HELPER_TRANSPORT_ABI,
    capabilities: [
      PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY,
      PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
    ],
    platform,
    source: {
      chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      skiaRevision: PAGED_CAPTURE_SKIA_REVISION,
      depotToolsRevision: PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION,
      patchSha256: PAGED_CAPTURE_HELPER_PATCH_SHA256,
      skiaPatchSha256: PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
    },
    protocol: {
      product: "HeadlessChrome/140.0.0.0",
      protocolVersion: "1.3",
      schemaSha256: sha256('{"domains":[]}'),
    },
    runtime: {
      executablePath: "headless_shell",
      runtimeDependenciesSha256: pagedCaptureHelperRuntimeDependenciesDigest(members),
      defaultEnabled: false,
      maximumSidecarBytes: PAGED_CAPTURE_HELPER_MAX_SIDECAR_BYTES,
    },
    distribution: {
      mode: "caller-supplied-local-bundle",
      automaticDownloads: false,
      updatePolicy: "manual-pinned-only",
      sourceArchiveUrl: "https://example.invalid/chromium-source.tar.zst",
      licenseFiles: ["LICENSE"],
    },
    members,
  };
  const manifestPath = join(root, "paged-capture-helper.json");
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestBytes);
  return { root, manifestPath, manifestSha256: sha256(manifestBytes), executablePath, runtimePath };
}

describe("paged-capture helper bundle", () => {
  it("keeps the published JSON Schema generated from the runtime authority", async () => {
    const schemaPath = new URL("../../schemas/paged-capture-helper-bundle.schema.json", import.meta.url);
    expect(await readFile(schemaPath, "utf8")).toBe(pagedCaptureHelperBundleJsonSchemaText());
    expect(buildPagedCaptureHelperBundleJsonSchema()).toMatchObject({
      $id: PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_ID,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
  });

  it("authenticates a caller-pinned manifest and every declared member", async () => {
    const input = await fixture();
    const verified = await verifyPagedCaptureHelperBundleForTest({
      manifestPath: input.manifestPath,
      expectedManifestSha256: input.manifestSha256,
    }, { platform: process.platform, architecture: process.arch });
    expect(verified.executablePath).toBe(await realpath(input.executablePath));
    expect(verified.manifest.distribution.automaticDownloads).toBe(false);
    expect(verified.manifest.transportAbi).toBe(PAGED_CAPTURE_HELPER_TRANSPORT_ABI);
  });

  it("fails closed for manifest, member, mode, platform, and symlink substitution drift", async () => {
    const manifestDrift = await fixture();
    await expect(verifyPagedCaptureHelperBundleForTest({
      manifestPath: manifestDrift.manifestPath,
      expectedManifestSha256: "0".repeat(64),
    }, { platform: process.platform, architecture: process.arch })).rejects.toThrow("manifest digest mismatch");

    const memberDrift = await fixture();
    await writeFile(memberDrift.runtimePath, "changed runtime dependency");
    await expect(verifyPagedCaptureHelperBundleForTest({
      manifestPath: memberDrift.manifestPath,
      expectedManifestSha256: memberDrift.manifestSha256,
    }, { platform: process.platform, architecture: process.arch })).rejects.toThrow("member identity mismatch");

    const modeDrift = await fixture();
    await chmod(modeDrift.executablePath, 0o644);
    await expect(verifyPagedCaptureHelperBundleForTest({
      manifestPath: modeDrift.manifestPath,
      expectedManifestSha256: modeDrift.manifestSha256,
    }, { platform: process.platform, architecture: process.arch })).rejects.toThrow("mode mismatch");

    const platformDrift = await fixture();
    await expect(verifyPagedCaptureHelperBundleForTest({
      manifestPath: platformDrift.manifestPath,
      expectedManifestSha256: platformDrift.manifestSha256,
    }, {
      platform: process.platform === "linux" ? "darwin" : "linux",
      architecture: process.arch,
    })).rejects.toThrow("platform mismatch");

    const symlinkDrift = await fixture();
    await rm(symlinkDrift.runtimePath);
    await symlink("headless_shell", symlinkDrift.runtimePath);
    await expect(verifyPagedCaptureHelperBundleForTest({
      manifestPath: symlinkDrift.manifestPath,
      expectedManifestSha256: symlinkDrift.manifestSha256,
    }, { platform: process.platform, architecture: process.arch })).rejects.toThrow("not a regular file");
  });

  it("rejects path, executable, license, ordering, and closure-digest ambiguity", async () => {
    const input = await fixture();
    type HostileManifest = {
      members: Array<Record<string, unknown> & { path: string }>;
      runtime: { executablePath: string; runtimeDependenciesSha256: string };
      distribution: { licenseFiles: string[] };
    };
    const parsed = JSON.parse(await readFile(input.manifestPath, "utf8")) as HostileManifest;
    const mutations: Array<(value: HostileManifest) => void> = [
      (value) => { value.members[0].path = "../LICENSE"; },
      (value) => { value.runtime.executablePath = "runtime.bin"; },
      (value) => { value.distribution.licenseFiles = ["runtime.bin"]; },
      (value) => { value.members.reverse(); },
      (value) => { value.runtime.runtimeDependenciesSha256 = "0".repeat(64); },
      (value) => { value.members.push({ ...value.members[0] }); },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(parsed);
      mutate(hostile);
      expect(() => parsePagedCaptureHelperBundleManifest(hostile)).toThrow();
    }
  });

  it("rejects malformed platform versions and unsupported setuid claims", async () => {
    const input = await fixture();
    const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as Record<string, unknown> & {
      platform: Record<string, unknown>;
    };
    manifest.platform = {
      os: "darwin",
      architecture: process.arch,
      minimumVersion: "13.not-a-version",
      codeSignatureIdentity: "unsigned-ad-hoc",
      quarantineState: "absent",
    };
    expect(() => parsePagedCaptureHelperBundleManifest(manifest)).toThrow();
    manifest.platform = {
      os: "linux",
      architecture: process.arch,
      glibcMinimum: "2.31",
      sandboxMode: "setuid",
      dtNeededSha256: sha256("DT_NEEDED closure"),
    };
    expect(() => parsePagedCaptureHelperBundleManifest(manifest)).toThrow();
  });

  it("does not admit inherited loader-control paths into the launch environment", () => {
    const inherited = {
      PATH: "/attacker/bin",
      LD_PRELOAD: "/attacker/lib.so",
      DYLD_INSERT_LIBRARIES: "/attacker/lib.dylib",
      SystemRoot: "Z:\\attacker",
      WINDIR: "Z:\\attacker",
      NODE_OPTIONS: "--require=/attacker/hook.js",
      LANG: "en_US.UTF-8",
    };
    expect(pagedCaptureHelperLaunchEnvironmentForTest(inherited, "linux", "/bundle")).toEqual({
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    expect(pagedCaptureHelperLaunchEnvironmentForTest(inherited, "win32", "C:\\bundle")).toEqual({
      PATH: "C:\\bundle",
    });
  });

  it("authenticates the live browser and every renderer image against one executable", async () => {
    const input = await fixture();
    const helper = await verifyPagedCaptureHelperBundleForTest({
      manifestPath: input.manifestPath,
      expectedManifestSha256: input.manifestSha256,
    }, { platform: process.platform, architecture: process.arch });
    let detached = false;
    const cdp = {
      send: async (method: string) => method === "Browser.getVersion"
        ? { product: "HeadlessChrome/140.0.0.0", protocolVersion: "1.3" }
        : { processInfo: [
          { id: 10, type: "browser" },
          { id: 30, type: "renderer" },
          { id: 20, type: "renderer" },
          { id: 40, type: "gpu-process" },
        ] },
      detach: async () => { detached = true; },
    };
    const browser = {
      newBrowserCDPSession: async () => cdp,
    } as unknown as Browser;
    const authenticated = await authenticatePagedCaptureHelperProcessesForTest(browser, helper, {
      processImage: authenticatedProcessImage(input.executablePath),
    });
    expect(authenticated).toMatchObject({
      browserProcessId: 10,
      rendererProcessIds: [20, 30],
      executableSha256: sha256("authenticated executable"),
    });
    expect(detached).toBe(true);

    const otherPath = join(input.root, "other-browser");
    await writeFile(otherPath, "authenticated executable");
    await expect(authenticatePagedCaptureHelperProcessesForTest(browser, helper, {
      processImage: authenticatedProcessImage(otherPath),
    })).rejects.toThrow("image path mismatch");
  });

  it("rejects missing renderers and live protocol drift", async () => {
    const input = await fixture();
    const helper = await verifyPagedCaptureHelperBundleForTest({
      manifestPath: input.manifestPath,
      expectedManifestSha256: input.manifestSha256,
    }, { platform: process.platform, architecture: process.arch });
    const browser = (product: string, rows: Array<{ id: number; type: string }>) => ({
      newBrowserCDPSession: async () => ({
        send: async (method: string) => method === "Browser.getVersion"
          ? { product, protocolVersion: "1.3" }
          : { processInfo: rows },
        detach: async () => undefined,
      }),
    }) as unknown as Browser;
    await expect(authenticatePagedCaptureHelperProcessesForTest(
      browser("HeadlessChrome/140.0.0.0", [{ id: 1, type: "browser" }]),
      helper,
      { processImage: authenticatedProcessImage(input.executablePath) },
    )).rejects.toThrow("at least one live renderer");
    await expect(authenticatePagedCaptureHelperProcessesForTest(
      browser("HeadlessChrome/141.0.0.0", [{ id: 1, type: "browser" }, { id: 2, type: "renderer" }]),
      helper,
      { processImage: authenticatedProcessImage(input.executablePath) },
    )).rejects.toThrow("product/protocol identity mismatch");
  });

  it("binds the default-off/active transport handshake to response PIDs without reading PDF bytes", async () => {
    const input = await fixture();
    const helper = await verifyPagedCaptureHelperBundleForTest({
      manifestPath: input.manifestPath,
      expectedManifestSha256: input.manifestSha256,
    }, { platform: process.platform, architecture: process.arch });
    const sidecar = JSON.stringify({
      helperAbi: PAGED_CAPTURE_HELPER_TABLE_TRANSPORT_ABI,
      sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      capturePhase: "after-PrintBegin-before-PrintEnd",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      frameToken: "frame-token",
      documentToken: "document-token",
      documentUrl: "about:blank",
      printCaptureId: "11111111-1111-4111-8111-111111111111",
      printParameters: {
        printableArea: { x: 0, y: 0, width: 240, height: 240 },
        defaultPage: {
          width: 240,
          height: 240,
          marginTop: 16,
          marginRight: 16,
          marginBottom: 16,
          marginLeft: 16,
          orientation: 0,
          pageSizeType: 0,
        },
        printerDpi: 72,
        scaleFactor: 1,
        ignoreCssMargins: false,
        ignorePageSize: false,
        rasterizePdf: false,
        printScalingOption: 0,
        usePaginatedLayout: true,
        printingInternalHeadersAndFooters: false,
        pagesPerSheet: 1,
        shouldPrintBackgrounds: true,
      },
      pages: [{
        pageIndex: 0,
        pageName: null,
        emptyKind: "none",
        tableOccurrences: [{
          physicalTableFragmentId: "table-fragment",
          tableSourceIndex: 0,
          occurrenceIndex: 0,
          pageIndex: 0,
          firstTableBox: true,
          lastTableBox: true,
          writingMode: "horizontal-tb",
          direction: "ltr",
          fragmentationAxis: "physical-y",
          progression: "positive",
          totalRows: 1,
          totalColumns: 1,
          globalColumnOffsets: [0, 100],
          sectionOccurrences: [{
            physicalSectionFragmentId: "section-fragment",
            sectionSourceIndex: 0,
            sectionTag: "tbody",
            occurrenceIndex: 0,
            repeatRole: "body",
            sectionPaintSlot: 0,
            tableChildPaintSlot: 0,
            globalRows: { start: 0, endExclusive: 1 },
            logicalRowOffsets: [0, 20],
            startBreak: { kind: "none", globalRowIndex: null },
            endBreak: { kind: "none", globalRowIndex: null },
            repeatEligibility: null,
            reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 0 },
          }],
          captionOccurrences: [],
          spanningCells: [],
          resolvedCollapsedEdgeGrid: [{
            sourceEdgeIndex: 0,
            axis: "block",
            globalRowBoundary: 0,
            globalColumnBoundary: 0,
            doNotFill: false,
            winner: { widthCssPx: 2, style: "solid", boxOrder: 0 },
          }, {
            sourceEdgeIndex: 1,
            axis: "inline",
            globalRowBoundary: 0,
            globalColumnBoundary: 0,
            doNotFill: false,
            winner: null,
          }, {
            sourceEdgeIndex: 2,
            axis: "block",
            globalRowBoundary: 0,
            globalColumnBoundary: 1,
            doNotFill: false,
            winner: null,
          }, {
            sourceEdgeIndex: 5,
            axis: "inline",
            globalRowBoundary: 1,
            globalColumnBoundary: 0,
            doNotFill: false,
            winner: null,
          }],
          collapsedEdges: [{
            sourceEdgeIndex: 0,
            decisionOrder: 0,
            paintOrder: 0,
            axis: "block",
            globalRowBoundary: 0,
            globalColumnBoundary: 0,
            winner: { widthCssPx: 2, style: "solid", boxOrder: 0 },
            disposition: "paint-full",
            logicalRectRaw: { inlineStart: -64, blockStart: 0, inlineSize: 128, blockSize: 1280 },
            startJoint: {
              precedence: ["after", "under", "before", "over"],
              winner: "self",
            },
            endJoint: {
              precedence: ["after", "under", "before", "over"],
              winner: "self",
            },
          }],
        }],
      }],
    });
    let printCount = 0;
    const pageCdp = {
      send: async (method: string) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "frame-id", loaderId: "loader-id" } } };
        }
        if (method === "Schema.getDomains") return { domains: [] };
        if (method === "Page.printToPDF") {
          printCount += 1;
          return printCount === 1
            ? { stream: "ordinary-stream" }
            : {
              stream: "active-stream",
              domotionPagedTableEvidence: sidecar,
              domotionPagedPageRecord: JSON.stringify({
                helperAbi: "domotion-paged-page-record-v1",
                sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
                printCaptureId: "11111111-1111-4111-8111-111111111111",
                pages: [{ status: "authenticated", vectorPaintSvg: '<svg width="240" height="240"/>' }],
              }),
              domotionBrowserProcessId: 10,
              domotionRendererProcessId: 20,
              domotionSourceRestoredExactly: true,
            };
        }
        if (method === "IO.close") return {};
        throw new Error(`unexpected page CDP method ${method}`);
      },
      detach: async () => undefined,
    };
    const browserCdp = {
      send: async (method: string) => method === "Browser.getVersion"
        ? { product: "HeadlessChrome/140.0.0.0", protocolVersion: "1.3" }
        : { processInfo: [{ id: 10, type: "browser" }, { id: 20, type: "renderer" }] },
      detach: async () => undefined,
    };
    const sourceState = {
      url: "about:blank",
      html: "<html><head></head><body></body></html>",
      scroll: [0, 0],
      viewport: [480, 360, 1],
      printMediaMatches: false,
      styles: [],
    };
    const browser = {
      newBrowserCDPSession: async () => browserCdp,
      newContext: async () => ({
        newPage: async () => ({
          setContent: async () => undefined,
          evaluate: async () => sourceState,
          url: () => "about:blank",
        }),
        newCDPSession: async () => pageCdp,
        close: async () => undefined,
      }),
    } as unknown as Browser;
    const transport = await authenticatePagedCaptureHelperTransportForTest(
      browser,
      helper,
      { processImage: authenticatedProcessImage(input.executablePath) },
    );
    expect(transport).toMatchObject({
      browserProcessId: 10,
      rendererProcessId: 20,
      runtimeDefaultDisabled: true,
      pdfBytesReadForLogicalFacts: false,
      printLayoutEpochRestoredExactly: true,
      sidecarSha256: sha256(sidecar),
    });
    expect(printCount).toBe(2);
  });
});
