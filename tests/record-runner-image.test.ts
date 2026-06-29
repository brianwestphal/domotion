// DM-1426: guard the CI runner-image identifier against the "unknown-x64"
// regression — the Linux visual-tests job runs inside the playwright:*-noble
// container where the host `ImageOS` env is unset, so the old inline
// `"${ImageOS:-unknown}-${RUNNER_ARCH}"` recorded a meaningless `unknown-x64`
// for every Linux baseline's meta.image.

import { describe, it, expect } from "vitest";
import { computeRunnerImage, parseOsRelease } from "../scripts/record-runner-image.mjs";

describe("computeRunnerImage", () => {
  it("uses ImageOS on host runners (macOS) — preserves the existing label", () => {
    // macos-latest exposes ImageOS like "macOS15"; matches the committed
    // unicode-macos.json meta.image "macos15-arm64".
    expect(computeRunnerImage({ imageOS: "macOS15", runnerArch: "ARM64" })).toBe("macos15-arm64");
  });

  it("uses ImageOS on host runners (Windows)", () => {
    expect(computeRunnerImage({ imageOS: "Win22", runnerArch: "X64" })).toBe("win22-x64");
  });

  it("derives a Playwright-versioned id inside the Linux container (the DM-1426 fix)", () => {
    const id = computeRunnerImage({
      runnerArch: "X64",
      osRelease: { VERSION_CODENAME: "noble", VERSION_ID: "24.04" },
      playwrightVersion: "1.59.1",
    });
    expect(id).toBe("playwright-v1.59.1-noble-x64");
  });

  it("NEVER yields the meaningless 'unknown-<arch>' when container metadata is present", () => {
    // The regression sentinel: this is exactly what the old workflow recorded.
    const id = computeRunnerImage({
      runnerArch: "X64",
      osRelease: { VERSION_CODENAME: "noble" },
      playwrightVersion: "1.59.1",
    });
    expect(id.startsWith("unknown")).toBe(false);
    expect(id).not.toBe("unknown-x64");
  });

  it("falls back to the codename when the Playwright version can't be resolved", () => {
    expect(computeRunnerImage({ runnerArch: "X64", osRelease: { VERSION_CODENAME: "noble" } }))
      .toBe("noble-x64");
  });

  it("falls back to VERSION_ID, then 'linux', when no codename", () => {
    expect(computeRunnerImage({ runnerArch: "X64", osRelease: { VERSION_ID: "24.04" } })).toBe("24.04-x64");
    expect(computeRunnerImage({ runnerArch: "X64", osRelease: {} })).toBe("linux-x64");
    expect(computeRunnerImage({ runnerArch: "X64" })).toBe("linux-x64");
  });

  it("treats an empty/whitespace ImageOS as unset (container path)", () => {
    const id = computeRunnerImage({ imageOS: "  ", runnerArch: "X64", osRelease: { VERSION_CODENAME: "noble" } });
    expect(id).toBe("noble-x64");
  });

  it("defaults a missing arch to 'unknown' but keeps a real image component", () => {
    expect(computeRunnerImage({ imageOS: "macOS15" })).toBe("macos15-unknown");
  });
});

describe("parseOsRelease", () => {
  it("parses KEY=VALUE lines and strips quotes", () => {
    const text = [
      'NAME="Ubuntu"',
      "VERSION_ID=\"24.04\"",
      "VERSION_CODENAME=noble",
      "# a comment",
      "",
      "PRETTY_NAME='Ubuntu 24.04.1 LTS'",
    ].join("\n");
    const r = parseOsRelease(text);
    expect(r.VERSION_CODENAME).toBe("noble");
    expect(r.VERSION_ID).toBe("24.04");
    expect(r.PRETTY_NAME).toBe("Ubuntu 24.04.1 LTS");
    expect(r.NAME).toBe("Ubuntu");
  });
});
