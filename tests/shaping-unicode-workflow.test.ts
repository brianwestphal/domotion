import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/shaping-unicode-conformance.yml", "utf8");
describe("Unicode shaping conformance workflow", () => {
  it("gates representative evidence on every supported OS", () => {
    // GitHub expressions contain braces; placing them in an unquoted YAML flow
    // mapping makes the workflow invalid before any job is created.
    expect(workflow).not.toMatch(/with:\s*\{[^\n]*\$\{\{/);
    expect(workflow.match(/npx playwright install chromium/g)).toHaveLength(2);
    expect(workflow.match(/mkdir -p tests\/output\/shaping-unicode/g)).toHaveLength(2);
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("[macos-14, ubuntu-24.04, windows-2025]");
    expect(workflow).toContain("--mode representative --shard 0/1");
  });
  it("schedules the exhaustive eight-shard corpus and retains resumable evidence", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("shard: [0, 1, 2, 3, 4, 5, 6, 7]");
    expect(workflow).toContain("--mode exhaustive --shard");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });
});
