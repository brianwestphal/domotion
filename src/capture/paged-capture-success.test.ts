import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  close: vi.fn(async () => undefined),
  launch: vi.fn(),
  render: vi.fn(),
}));

vi.mock("./paged-capture-helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paged-capture-helper.js")>();
  return {
    ...actual,
    launchPagedCaptureHelper: mocks.launch,
    pagedCaptureHelperRuntimeDependenciesDigest: () => "d".repeat(64),
  };
});

vi.mock("./paged-page-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paged-page-record.js")>();
  return { ...actual, captureAuthenticatedPagedPageRecord: mocks.capture };
});

vi.mock("../render/paged-page-svg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../render/paged-page-svg.js")>();
  return { ...actual, renderAuthenticatedPagedSvgPages: mocks.render };
});

import { capturePagedSvgBundle } from "./paged-capture.js";

const temporaryRoots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const svg = '<svg width="120" height="90" viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function arrangeAuthenticatedCapture() {
  const page = {
    evaluate: vi.fn(async () => ({
      count: 1,
      url: "https://example.test/report",
      outerHTML: "<main id=report>ready</main>",
      computed: [["display", "block"]],
    })),
  };
  mocks.launch.mockResolvedValue({
    browser: {
      newContext: vi.fn(async () => ({ newPage: vi.fn(async () => page) })),
      close: mocks.close,
    },
    helper: {
      manifestSha256: "a".repeat(64),
      manifest: {
        runtime: { executablePath: "chrome" },
        members: [{ path: "chrome", role: "executable", sha256: "b".repeat(64) }],
      },
    },
  });
  mocks.capture.mockResolvedValue({
    status: "authenticated",
    document: {
      browserProcessId: 10,
      rendererProcessId: 20,
      browserVersion: "HeadlessChrome/140.0.0.0",
      protocolVersion: "1.3",
      printEpochId: "epoch-1",
      frameId: "frame-1",
      loaderId: "loader-1",
      printParametersSha256: "c".repeat(64),
    },
  });
  mocks.render.mockReturnValue([{
    selectionIndex: 0,
    pageIndex: 1,
    pageNumber: 2,
    pageName: null,
    emptyKind: "none",
    widthCssPx: 120,
    heightCssPx: 90,
    svg,
    svgByteLength: Buffer.byteLength(svg),
    svgSha256: hash(svg),
    pageRecordSha256: hash("page-record"),
    collapsedBorderRectCount: 0,
    collapsedBorderConsistencySha256: hash("collapsed"),
  }]);
  return page;
}

describe("paged capture public orchestration", () => {
  it("prepares the helper-owned page and publishes the authenticated sparse selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "domotion-paged-capture-"));
    temporaryRoots.push(root);
    const page = arrangeAuthenticatedCapture();
    const preparePage = vi.fn(async (preparedPage: unknown) => {
      expect(preparedPage).toBe(page);
    });

    const manifest = await capturePagedSvgBundle({
      helperManifestPath: "/caller/pinned/helper.json",
      expectedHelperManifestSha256: "e".repeat(64),
      outputManifestPath: join(root, "report.domotion-pages.json"),
      preparePage,
      sourceSelector: "#report",
      print: { pageRanges: " 2 ", printBackground: false, preferCSSPageSize: true },
    });

    expect(preparePage).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
      manifestPath: "/caller/pinned/helper.json",
      expectedManifestSha256: "e".repeat(64),
    }));
    expect(mocks.capture).toHaveBeenCalledWith(expect.anything(), page, expect.objectContaining({
      pageRanges: "2",
      printBackground: false,
      preferCSSPageSize: true,
    }));
    expect(manifest).toMatchObject({
      bundleStem: "report",
      request: { pageRanges: "2", printBackground: false, preferCSSPageSize: true },
      pages: [{ selectionIndex: 0, pageIndex: 1, pageNumber: 2 }],
    });
    expect(await readFile(join(root, "report.pages/page-0002.svg"), "utf8")).toBe(svg);
    expect(JSON.parse(await readFile(join(root, "report.domotion-pages.json"), "utf8"))).toEqual(manifest);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("fails closed when the helper returns a page outside the requested range", async () => {
    const root = await mkdtemp(join(tmpdir(), "domotion-paged-capture-"));
    temporaryRoots.push(root);
    arrangeAuthenticatedCapture();
    await expect(capturePagedSvgBundle({
      helperManifestPath: "/caller/pinned/helper.json",
      expectedHelperManifestSha256: "e".repeat(64),
      outputManifestPath: join(root, "report.domotion-pages.json"),
      preparePage: async () => undefined,
      print: { pageRanges: "3" },
    })).rejects.toMatchObject({ code: "capture-unavailable" });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
