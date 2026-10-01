import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkActivationCoverage } from "../tools/check-activation-coverage.js";
import { checkNativeScrollbarRelease } from "../tools/check-native-scrollbar-release.js";
import { checkParityRelease } from "../tools/check-parity-release.js";
import { checkSemanticCoverage } from "../tools/check-semantic-coverage.js";

describe("migrated check commands", () => {
  it("validates flags before reading reports or ledgers", async () => {
    await expect(checkActivationCoverage(["--json"])).rejects.toThrow();
    await expect(checkActivationCoverage(["--unknown"])).rejects.toThrow();
    await expect(checkNativeScrollbarRelease([])).rejects.toThrow(/reports/);
    await expect(checkNativeScrollbarRelease(["--reports", "missing", "--unknown"])).rejects.toThrow();
    await expect(checkParityRelease(["--evidence"])).rejects.toThrow();
    await expect(checkSemanticCoverage(["--unknown"])).rejects.toThrow();
  });

  it("runs the semantic inventory through the real CLI", () => {
    const result = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), ["tools/check-semantic-coverage.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Semantic coverage inventory is structurally valid");
  });

  it("keeps a blocked native release at exit 1 while report-only exits 0", async () => {
    const reports = mkdtempSync(join(tmpdir(), "domotion-scrollbar-cli-"));
    expect(await checkNativeScrollbarRelease(["--reports", reports])).toBe(1);
    expect(await checkNativeScrollbarRelease(["--reports", reports, "--report-only"])).toBe(0);
  });
});
