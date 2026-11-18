import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIRECT_SOURCE_FILES,
  retryDelayMs,
  SOURCE_AUTHORITY_PINS,
  sourceAuthorityPlan,
  sourceUrlFor,
} from "../scripts/materialize-source-authorities.mjs";

const inventory = JSON.parse(readFileSync(resolve(__dirname, "..", "tools/semantic-coverage.json"), "utf8"));
const parityProgram = JSON.parse(readFileSync(resolve(__dirname, "..", "tools/parity-program.json"), "utf8"));

describe("clean-checkout source authority materialization", () => {
  it("owns every external semantic reference and direct source assertion", () => {
    const plan = sourceAuthorityPlan(inventory, parityProgram);
    const planned = new Set([...plan.files, ...plan.directories]);
    const semanticRefs = inventory.transitions
      .flatMap((row: Record<string, unknown>) =>
        Object.values(row).flatMap((value) => (Array.isArray(value) ? value : [])),
      )
      .filter((ref: unknown): ref is string => typeof ref === "string")
      .filter((ref: string) => ref.startsWith("external/"));
    const parityRefs = parityProgram.areas
      .flatMap((area: { upstreamSources?: string[] }) => area.upstreamSources ?? [])
      .filter((ref: string) => ref.startsWith("external/"));
    expect([...semanticRefs, ...parityRefs, ...DIRECT_SOURCE_FILES].filter((ref) => !planned.has(ref))).toEqual([]);
    expect(plan.files.length).toBeGreaterThan(100);
  });

  it("maps every source family to an immutable revision", () => {
    expect(sourceUrlFor("external/chromium/a.cc")).toMatchObject({ pin: SOURCE_AUTHORITY_PINS.chromium });
    expect(sourceUrlFor("external/chromium/third_party/icu/a.txt")).toMatchObject({ pin: SOURCE_AUTHORITY_PINS.icu });
    expect(sourceUrlFor("external/skia/a.cc")).toMatchObject({ pin: SOURCE_AUTHORITY_PINS.skia });
    expect(sourceUrlFor("external/harfbuzz/src/a.cc")).toMatchObject({ pin: SOURCE_AUTHORITY_PINS.harfbuzz });
    expect(sourceUrlFor("external/html-test/a.html")).toMatchObject({ pin: SOURCE_AUTHORITY_PINS.htmlTest });
    for (const ref of DIRECT_SOURCE_FILES) expect(sourceUrlFor(ref).url).toContain(sourceUrlFor(ref).pin);
  });

  it("materializes every Chromium input used by the MathML dictionary generator", () => {
    const generator = readFileSync(resolve(__dirname, "..", "tools/generate-mathml-operator-dictionary.mjs"), "utf8");
    const inputs = generator.match(/external\/chromium\/[^"\n]+\.cc/g) ?? [];
    const planned = new Set(sourceAuthorityPlan(inventory, parityProgram).files);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter((path) => !planned.has(path))).toEqual([]);
  });

  it("rejects paths outside the external authority roots", () => {
    expect(() => sourceUrlFor("external/../package.json")).toThrow(/escapes external/);
    expect(() => sourceUrlFor("package.json")).toThrow(/escapes external/);
  });
});

// DM-JMZAA4: a GitHub raw-content 429 outlasted the 1/2/4/8 s backoff and
// failed the CI test job before any test ran.
describe("source authority fetch retries and CI cache", () => {
  it("honors Retry-After on rate limits and otherwise backs off longer", () => {
    expect(retryDelayMs(1, 429, "7")).toBe(7_000);
    expect(retryDelayMs(2, 503, "0")).toBe(0);
    expect(retryDelayMs(1, 429, "600")).toBe(60_000);
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, 429, null))).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(retryDelayMs(5, 429, "not-a-number")).toBe(60_000);
    expect([1, 2, 3].map((attempt) => retryDelayMs(attempt, undefined, null))).toEqual([1_000, 2_000, 4_000]);
    expect(retryDelayMs(1, 404, "9")).toBe(1_000);
  });

  it("restores the pinned tree on an exact key before CI materializes it", () => {
    const workflow = readFileSync(resolve(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    const restore = workflow.indexOf("name: Restore pinned source authorities");
    const materialize = workflow.indexOf("name: Materialize pinned source authorities");
    expect(restore).toBeGreaterThan(-1);
    expect(materialize).toBeGreaterThan(restore);
    const step = workflow.slice(restore, materialize);
    expect(step).toContain("uses: actions/cache@v4");
    expect(step).toContain("path: external");
    expect(step).toContain(
      "hashFiles('scripts/materialize-source-authorities.mjs', 'tools/semantic-coverage.json', 'tools/parity-program.json')",
    );
    // A partial restore would trip the materializer's unowned-file refusal.
    expect(step).not.toContain("restore-keys");
  });
});
