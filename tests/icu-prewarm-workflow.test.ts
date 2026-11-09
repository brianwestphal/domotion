import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("cold macOS ICU acquisition gate (DM-T9Z4HF)", () => {
  it("validates the companion before the primary unit workers start", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      jobs: { test: { steps: Array<{ run?: string }> } };
    };
    const commands = workflow.jobs.test.steps.map((step) => step.run ?? "");
    const prewarm = commands.indexOf("npm run fonts:prewarm-icu");
    expect(prewarm).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("npm test")).toBeGreaterThan(prewarm);
    expect(commands.indexOf("npm test --workspace @domotion/text-engine")).toBeGreaterThan(prewarm);

    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["fonts:prewarm-icu"]).toBe(
      "npm run build:text-engine && node scripts/prewarm-icu-companion.mjs",
    );
  });
});
