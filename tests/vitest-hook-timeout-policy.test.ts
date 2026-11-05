import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DM-2AJJPJ: the E2E config raised `testTimeout` to 60 s but left `hookTimeout`
// at Vitest's 10 s default, so a `beforeAll` that launched Chromium under load
// failed with "Hook timed out in 10000ms" while the same file passed alone.
// Every Vitest config must give hooks at least the test budget.
const CONFIGS = [
  "vitest.config.ts",
  "vitest.e2e.config.ts",
  "packages/text-engine/vitest.config.ts",
  "packages/text-engine/vitest.performance.config.ts",
];

function numericOption(source: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}:\\s*([0-9_]+)`).exec(source);
  return match?.[1] === undefined ? undefined : Number(match[1].replaceAll("_", ""));
}

describe("Vitest hook timeout policy (DM-2AJJPJ)", () => {
  it.each(CONFIGS)("%s sets hookTimeout >= testTimeout", (file) => {
    const source = readFileSync(resolve(import.meta.dirname, "..", file), "utf-8");
    const testTimeout = numericOption(source, "testTimeout");
    const hookTimeout = numericOption(source, "hookTimeout");
    expect(testTimeout, `${file} declares testTimeout`).toBeTypeOf("number");
    expect(hookTimeout, `${file} declares hookTimeout`).toBeTypeOf("number");
    expect(hookTimeout).toBeGreaterThanOrEqual(testTimeout ?? Infinity);
  });
});
