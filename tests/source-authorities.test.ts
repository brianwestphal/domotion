import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIRECT_SOURCE_FILES,
  SOURCE_AUTHORITY_PINS,
  sourceAuthorityPlan,
  sourceUrlFor,
} from "../scripts/materialize-source-authorities.mjs";

const inventory = JSON.parse(readFileSync(resolve(__dirname, "..", "tools/semantic-coverage.json"), "utf8"));

describe("clean-checkout source authority materialization", () => {
  it("owns every external semantic reference and direct source assertion", () => {
    const plan = sourceAuthorityPlan(inventory);
    const planned = new Set([...plan.files, ...plan.directories]);
    const semanticRefs = inventory.transitions
      .flatMap((row: Record<string, unknown>) => Object.values(row)
        .flatMap((value) => Array.isArray(value) ? value : []))
      .filter((ref: unknown): ref is string => typeof ref === "string")
      .filter((ref: string) => ref.startsWith("external/"));
    expect([...semanticRefs, ...DIRECT_SOURCE_FILES].filter((ref) => !planned.has(ref))).toEqual([]);
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

  it("rejects paths outside the external authority roots", () => {
    expect(() => sourceUrlFor("external/../package.json")).toThrow(/escapes external/);
    expect(() => sourceUrlFor("package.json")).toThrow(/escapes external/);
  });
});
