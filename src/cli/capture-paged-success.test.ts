import { describe, expect, it, vi } from "vitest";

const capturePagedSvgBundle = vi.hoisted(() => vi.fn(async (options: {
  preparePage(page: unknown): Promise<void>;
}) => {
  const page = {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  };
  await options.preparePage(page);
  return { pages: [{ pageNumber: 1 }] };
}));
const loadInputIntoPage = vi.hoisted(() => vi.fn(async () => undefined));
const applyReadyWaits = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../capture/paged-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture/paged-capture.js")>();
  return { ...actual, capturePagedSvgBundle };
});

vi.mock("./common.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./common.js")>();
  return { ...actual, loadInputIntoPage, applyReadyWaits };
});

import { runCapture } from "./capture.js";

describe("capture paged-mode CLI mapping", () => {
  it("maps explicit helper, source, settling, and print flags to the paged API", async () => {
    await runCapture([
      "report.html",
      "--paged",
      "--paged-helper-manifest", "helper.json",
      "--paged-helper-sha256", "a".repeat(64),
      "--output", "report.domotion-pages.json",
      "--selector", "#report",
      "--wait", "50",
      "--wait-for", ".ready",
      "--page-width", "7.5",
      "--page-height", "10",
      "--page-margin-top", "0",
      "--page-margin-right", "0.25",
      "--page-margin-bottom", "0.5",
      "--page-margin-left", "0.75",
      "--page-ranges", "1-3,7",
      "--page-scale", "0.9",
      "--landscape",
      "--no-print-background",
      "--prefer-css-page-size",
      "--quiet",
    ], "");

    expect(capturePagedSvgBundle).toHaveBeenCalledWith(expect.objectContaining({
      helperManifestPath: "helper.json",
      expectedHelperManifestSha256: "a".repeat(64),
      outputManifestPath: "report.domotion-pages.json",
      sourceSelector: "#report",
      print: {
        paperWidthInches: 7.5,
        paperHeightInches: 10,
        marginTopInches: 0,
        marginRightInches: 0.25,
        marginBottomInches: 0.5,
        marginLeftInches: 0.75,
        pageRanges: "1-3,7",
        scale: 0.9,
        landscape: true,
        printBackground: false,
        preferCSSPageSize: true,
      },
    }));
    expect(loadInputIntoPage).toHaveBeenCalledWith(expect.anything(), "report.html", { networkIdle: false });
    expect(applyReadyWaits).toHaveBeenCalledWith(expect.anything(), {
      wait: 50,
      waitFor: ".ready",
      fontsReady: true,
    });
  });
});
