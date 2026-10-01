import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const commands = [
  "backdrop-source-surface-audit.ts",
  "background-clip-text-oracle.ts",
  "blend-filter-pixel-stage-oracle.ts",
  "animated-projective-frame-oracle.ts",
  "border-phase-ratifier.ts",
  "fragmented-collapsed-table-release-gate.ts",
  "font-palette-ownership-audit.ts",
  "font-palette-paint-gate.ts",
];

describe("migrated paint oracle commands", () => {
  for (const command of commands) {
    it(`${command} rejects unknown and missing flags before browser work`, () => {
      for (const args of [["--unknown"], ["--json"]]) {
        const result = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), [`tools/${command}`, ...args], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/Unknown option|Option '--json <value>' argument missing/);
      }
    });
  }
});
