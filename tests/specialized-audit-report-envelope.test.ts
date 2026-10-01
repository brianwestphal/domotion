import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("specialized audit report artifact", () => {
  it("writes a nested envelope while preserving the emoji audit's flat stdout", () => {
    const output = join(mkdtempSync(join(tmpdir(), "domotion-specialized-audit-")), "nested", "report.json");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tools/emoji-presentation-ownership-audit.ts", "--json", output],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const stdout = JSON.parse(result.stdout);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(stdout).toMatchObject({ schemaVersion: 2, ticket: "DM-2507" });
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      tool: "emoji-presentation-ownership-audit",
      env: { platform: process.platform },
      data: stdout,
    });
    expect(artifact.data.outcome).toBe(
      stdout.verdict === "resolved-symbols-item-boundary"
        ? "pass"
        : stdout.verdict === "source-boundary-resolved-native-inapplicable"
          ? "skip"
          : "fail",
    );
  });
});
