import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DM-MM7R7D: the unit config forces the one-shot glyph-helper transport,
// because a persistent helper a Vitest fork leaves open leaks. Root tests that
// need the persistent channel for speed must take it through
// tests/persistent-glyph-helper.ts, which always closes it. A hand-written
// toggle of the variable is the shape that once forgot the close, so it is
// allowed only in that helper. The text-engine package's own transport tests
// toggle it to test the transport itself and are outside this scan.
const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = ["src", "tests"];
const HELPER = "tests/persistent-glyph-helper.ts";
const ALLOWED = new Set([HELPER, "tests/persistent-glyph-helper-policy.test.ts"]);
const TOGGLE =
  /process\.env(?:\.DOMOTION_HELPER_NO_SERVE|\[\s*["']DOMOTION_HELPER_NO_SERVE["']\s*\])\s*=(?!=)|delete\s+process\.env(?:\.DOMOTION_HELPER_NO_SERVE|\[\s*["']DOMOTION_HELPER_NO_SERVE["']\s*\])/;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "output" || entry.name === "cache" ? [] : sources(path);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [path] : [];
  });
}

export function helperToggleViolations(file: string, source: string): string[] {
  return !ALLOWED.has(file) && TOGGLE.test(source) ? [file] : [];
}

describe("persistent glyph-helper opt-in policy (DM-MM7R7D)", () => {
  it("toggles DOMOTION_HELPER_NO_SERVE in root code only through the shared helper", () => {
    const files = SCANNED.flatMap((root) => sources(resolve(ROOT, root)));
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((path) =>
      helperToggleViolations(relative(ROOT, path).split("\\").join("/"), readFileSync(path, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("detects assignment and deletion in either property form, and allows only the helper", () => {
    for (const sample of [
      "delete process.env.DOMOTION_HELPER_NO_SERVE;",
      'delete process.env["DOMOTION_HELPER_NO_SERVE"];',
      'process.env.DOMOTION_HELPER_NO_SERVE = "1";',
      "process.env['DOMOTION_HELPER_NO_SERVE'] = saved;",
    ])
      expect(helperToggleViolations("tests/x.test.ts", sample)).toEqual(["tests/x.test.ts"]);
    expect(helperToggleViolations(HELPER, "delete process.env.DOMOTION_HELPER_NO_SERVE;")).toEqual([]);
    // Reading the variable is not a toggle.
    expect(helperToggleViolations("tests/x.test.ts", "const v = process.env.DOMOTION_HELPER_NO_SERVE;")).toEqual([]);
    expect(helperToggleViolations("tests/x.test.ts", "process.env.DOMOTION_HELPER_NO_SERVE === '1'")).toEqual([]);
  });

  it("is what the two persistent-channel tests use", () => {
    expect(readFileSync(resolve(ROOT, "tests/font-conformance.test.ts"), "utf8")).toContain(
      "withPersistentGlyphHelper(",
    );
    expect(readFileSync(resolve(ROOT, "tests/shaping-default-ignorable-logical.test.ts"), "utf8")).toContain(
      "usePersistentGlyphHelper()",
    );
  });
});
