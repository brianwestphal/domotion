import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBackgroundClipTextNative } from "../tools/background-clip-text-native-gate.js";

describe("migrated evidence commands", () => {
  it("rejects unknown native-gate options before reading reports", () => {
    expect(() => checkBackgroundClipTextNative(["--unknown"])).toThrow();
  });

  for (const command of ["animated-culling-geometry-oracle.ts", "build-stage-evidence.ts"]) {
    it(`${command} rejects missing and unknown options`, () => {
      for (const argv of [["--json"], ["--unknown"]]) {
        const child = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), [`tools/${command}`, ...argv], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        expect(child.status).toBe(2);
      }
    });
  }

  it("keeps adjudicator parse failures redacted", () => {
    const child = spawnSync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["tools/animated-image-owner-resource-truth-adjudicator.ts", "--secret"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("failed closed before verdict");
    expect(child.stderr).not.toContain("--secret");
  });
});
