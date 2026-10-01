import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCli as parseTruthCollectorCli } from "../tools/animated-image-owner-resource-truth-collector.js";
import { parseArgs as parseCropArgs } from "../tools/crop-regions.js";

const binary = join(process.cwd(), "node_modules/.bin/tsx");
function run(command: string, ...argv: string[]) {
  return spawnSync(binary, [`tools/${command}`, ...argv], { cwd: process.cwd(), encoding: "utf8" });
}

describe("migrated A–C commands", () => {
  it("collector validates all required and declared options before launch", () => {
    expect(() => parseTruthCollectorCli(["--unknown"])).toThrow();
    expect(() => parseTruthCollectorCli(["--os"])).toThrow();
    expect(() => parseTruthCollectorCli(["--os", "macOS"])).toThrow(/role/);
  });

  it("crop-regions accepts declared equals-form values", () => {
    expect(parseCropArgs(["--ticket=DM-ABC123", "--output-root=tests/output/region-crops"]).ref).toEqual({
      kind: "slug",
      slug: "DM-ABC123",
    });
  });

  for (const command of [
    "border-phase-oracle.ts",
    "broken-image-fallback-oracle.ts",
    "browser-harfbuzz-substitution-oracle.ts",
    "cluster-conformance.ts",
    "collapsed-border-fragmentation-oracle.ts",
    "crop-regions.ts",
    "animated-image-frame-selection-audit-cli.ts",
    "animated-image-production-release-gate-cli.ts",
    "assert-linux-system-ui-profile.ts",
    "assert-linux-helper-in-loop.ts",
    "capture-nytimes-snapshot.ts",
    "check-feature-coverage.ts",
  ]) {
    it(`${command} rejects unknown options before doing work`, () => {
      const child = run(command, "--unknown-option");
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/unknown|Unknown|invalid/i);
    });
  }
});
