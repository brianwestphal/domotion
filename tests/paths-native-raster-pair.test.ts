import { describe, expect, it } from "vitest";
import { chooseRasterPairs, type RasterArm } from "../tools/paths-native-raster-pair.js";

const platforms = ["darwin", "linux", "win32"] as const;

function arm(
  platform: RasterArm["platform"],
  label: RasterArm["label"],
  overrides: Partial<RasterArm> = {},
): RasterArm {
  return {
    directory: `${platform}-${label}`,
    runId: "100",
    runAttempt: "1",
    runnerName: `${platform}-${label}-runner`,
    platform,
    label,
    fingerprintSha256: `${platform}-fp-a`,
    rendererSourceSha256: "renderer-a",
    oracleSourceSha256: "oracle-a",
    fontInventorySha256: "fonts-a",
    cellSetSha256: `${platform}-cells`,
    ...overrides,
  };
}

describe("native-raster pairing", () => {
  it("chooses a complete exact-fingerprint pair even when first jobs straddle an image rollout", () => {
    const arms = platforms.flatMap((platform) => [arm(platform, "proposal"), arm(platform, "validation")]);
    const stale = arm("win32", "validation", {
      directory: "win32-stale-validation",
      runId: "099",
      fingerprintSha256: "win32-fp-old",
    });
    const selected = chooseRasterPairs([stale, ...arms].reverse());
    expect(selected).toHaveLength(6);
    expect(selected.find((entry) => entry.platform === "win32" && entry.label === "validation")?.directory).toBe(
      "win32-validation",
    );
    expect(chooseRasterPairs([stale, ...arms])).toEqual(selected);
  });

  it("withholds a mismatched source, cell census, or same-runner pair", () => {
    const complete = platforms.flatMap((platform) => [arm(platform, "proposal"), arm(platform, "validation")]);
    for (const mutation of [
      { oracleSourceSha256: "oracle-b" },
      { cellSetSha256: "different-cells" },
      { runnerName: "win32-proposal-runner" },
    ]) {
      const broken = complete.map((entry) =>
        entry.platform === "win32" && entry.label === "validation" ? { ...entry, ...mutation } : entry,
      );
      expect(() => chooseRasterPairs(broken)).toThrow("no complete same-source");
    }
  });

  it("requires source equality within each pair while permitting platform-specific source bytes", () => {
    const old = platforms.flatMap((platform) => [arm(platform, "proposal"), arm(platform, "validation")]);
    const newSource = old.map((entry) => ({
      ...entry,
      directory: `new-${entry.directory}`,
      runId: "200",
      rendererSourceSha256: "renderer-b",
      oracleSourceSha256: "oracle-b",
    }));
    expect(
      chooseRasterPairs([
        ...old.filter((entry) => entry.platform !== "win32"),
        ...newSource.filter((entry) => entry.platform === "win32"),
      ]),
    ).toEqual([
      ...old.filter((entry) => entry.platform !== "win32"),
      ...newSource.filter((entry) => entry.platform === "win32"),
    ]);
    expect(chooseRasterPairs(newSource)).toEqual(newSource);
  });
});
