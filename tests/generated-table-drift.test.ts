/**
 * DM-2020: drift gate for the two generated Unicode range tables this ticket
 * introduced — HarfBuzz's default-ignorable table and its USE left-matra
 * (VPre/VMPre) table. Both are decoded straight out of the checked-out
 * `external/harfbuzz` source by a committed generator script rather than
 * hand-curated; this test re-runs each generator and asserts its output is
 * BYTE-EQUAL to the committed `*.generated.ts` file, so a future edit that
 * hand-patches the generated file (or a HarfBuzz checkout bump that changes
 * the decoded set) shows up as a test failure instead of silent drift.
 *
 * Uses the argv form of `execFileSync` (not the shell-string `exec`/`execSync`
 * the DM-1332 audit disallows — see `tests/conventions.test.ts`), and
 * restores the original file content afterward so the test is non-destructive
 * to the working tree regardless of outcome — the assertion is the
 * before/after string comparison, not the side effect of having regenerated.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Both generators read `external/harfbuzz`, which is a LOCAL checkout — it is
 * gitignored and no CI job clones it. Without this guard the gate does not
 * merely skip on a machine that lacks it; the generator exits non-zero, the
 * regenerated file never appears, and the byte-comparison fails, turning every
 * checkout without the upstream source red for a reason that has nothing to do
 * with drift.
 *
 * Skipping is the honest behaviour: the gate's whole claim is "the committed
 * table still matches what the generator derives from upstream", and with no
 * upstream present there is nothing to compare against. A skip says that; a
 * failure would assert drift that was never measured.
 */
const harfbuzzAvailable = existsSync(path.join(repoRoot, "external/harfbuzz/src"));
const chromiumUnicodeAvailable = existsSync(path.join(
  repoRoot,
  "external/chromium/third_party/icu/source/data/unidata/ppucd.txt",
));

function assertGeneratorIsUpToDate(generatorRelPath: string, generatedRelPath: string) {
  const generatedPath = path.join(repoRoot, generatedRelPath);
  const before = readFileSync(generatedPath, "utf-8");
  try {
    execFileSync("node", [path.join(repoRoot, generatorRelPath)], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const after = readFileSync(generatedPath, "utf-8");
    expect(after).toBe(before);
  } finally {
    // Restore regardless of outcome — the test's assertion IS the
    // before/after diff; leaving the file rewritten (even identically) is
    // an unnecessary side effect on a read/verify test run.
    writeFileSync(generatedPath, before);
  }
}

(harfbuzzAvailable ? describe : describe.skip)("generated Unicode table drift gates", () => {
  it("harfbuzz-default-ignorable-ranges.generated.ts matches its generator", () => {
    assertGeneratorIsUpToDate(
      "tools/generate-harfbuzz-default-ignorable-ranges.mjs",
      "src/render/harfbuzz-default-ignorable-ranges.generated.ts",
    );
  });

  it("use-left-matra-ranges.generated.ts matches its generator", () => {
    assertGeneratorIsUpToDate(
      "tools/generate-use-left-matra-ranges.mjs",
      "src/render/use-left-matra-ranges.generated.ts",
    );
  });
});

(chromiumUnicodeAvailable ? describe : describe.skip)("generated Blink Unicode table drift gates", () => {
  it("cjk-ideograph-or-symbol-ranges.generated.ts matches Chromium and pinned ICU inputs", () => {
    assertGeneratorIsUpToDate(
      "tools/generate-cjk-ideograph-or-symbol-ranges.mjs",
      "src/render/cjk-ideograph-or-symbol-ranges.generated.ts",
    );
  });
  it("vertical-orientation.generated.ts matches Chromium-pinned ICU", () => {
    assertGeneratorIsUpToDate(
      "tools/generate-vertical-orientation-ranges.mjs",
      "src/capture/script/vertical-orientation.generated.ts",
    );
  });
});
