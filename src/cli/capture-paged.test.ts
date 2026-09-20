import { describe, expect, it } from "vitest";

import { runCapture } from "./capture.js";

describe("capture paged-mode CLI boundary", () => {
  it("requires explicit paged mode for every paged-only flag", async () => {
    await expect(runCapture(["page.html", "--page-ranges", "1-2"], ""))
      .rejects.toThrow("paged print flags require explicit --paged mode");
  });

  it("requires both helper trust anchors and an output manifest", async () => {
    await expect(runCapture(["page.html", "--paged"], ""))
      .rejects.toThrow("--paged requires --paged-helper-manifest and --paged-helper-sha256");
  });

  it("rejects ordinary viewport controls in paged mode before launch", async () => {
    await expect(runCapture([
      "page.html", "--paged", "--paged-helper-manifest", "helper.json",
      "--paged-helper-sha256", "a".repeat(64), "--output", "report.domotion-pages.json",
      "--width", "800",
    ], "")).rejects.toThrow("--paged is incompatible with ordinary capture flags: --width");
  });

  it("rejects the ordinary real-text layer in authenticated paged mode", async () => {
    await expect(runCapture([
      "page.html", "--paged", "--paged-helper-manifest", "helper.json",
      "--paged-helper-sha256", "a".repeat(64), "--output", "report.domotion-pages.json",
      "--real-text",
    ], "")).rejects.toThrow("--paged is incompatible with ordinary capture flags: --real-text");
  });

  it("rejects an unsafe paged output name before helper authentication", async () => {
    await expect(runCapture([
      "page.html", "--paged", "--paged-helper-manifest", "helper.json",
      "--paged-helper-sha256", "a".repeat(64), "--output", "report.json",
      "--quiet",
    ], "")).rejects.toThrow("output manifest must end in .domotion-pages.json");
  });

  // DM-2716: `--text-mode` selects the render text-emit strategy at the CLI.
  it("rejects an unknown --text-mode value before launch", async () => {
    await expect(runCapture(["page.html", "--text-mode", "bogus", "--quiet"], ""))
      .rejects.toThrow('--text-mode expects one of embedded-font, paths, system-font, got "bogus"');
  });
});
