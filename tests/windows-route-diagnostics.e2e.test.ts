// Diagnostic-only (validation branch, not for main): records raw native and
// Chromium evidence for two Windows synthetic-route classes before any repair.
//   NX68YR — box drawing under bold monospace: Chrome Lucida Sans Unicode vs our regular Consolas.
//   1EFA3S — supplementary CJK compatibility ideographs by locale.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable, resolveSystemFallbackFonts } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;
const FONTS = "C:\\Windows\\Fonts";

function log(tag: string, value: unknown): void {
  console.log(`DIAG ${tag} ${JSON.stringify(value)}`);
}

/** Every face in a TTF/TTC with its cmap coverage of `cps`. */
function faceCoverage(file: string, cps: number[]): unknown {
  const path = join(FONTS, file);
  if (!existsSync(path)) return { file, missing: true };
  const opened = fontkit.openSync(path) as unknown as {
    fonts?: { postscriptName: string; hasGlyphForCodePoint(cp: number): boolean }[];
    postscriptName: string;
    hasGlyphForCodePoint(cp: number): boolean;
  };
  const faces = opened.fonts ?? [opened];
  return {
    file,
    faces: faces.map((face) => ({
      ps: face.postscriptName,
      covers: Object.fromEntries(cps.map((cp) => [cp.toString(16).toUpperCase(), face.hasGlyphForCodePoint(cp)])),
    })),
  };
}

async function conformance(name: string, stacks: ReturnType<typeof syntheticCorpus>["stacks"], range: string) {
  const root = mkdtempSync(join(tmpdir(), `domotion-diag-${name}-`));
  const stacksFile = join(root, "stacks.json");
  const output = join(root, "out");
  writeFileSync(stacksFile, JSON.stringify({ ...syntheticCorpus(), stacks }));
  await main(["--stacks", stacksFile, "--range", range, "--out", output]);
  const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
  log(`${name}:summary`, { comparisons: report.data.summary.comparisons, mismatches: report.data.summary.mismatchTotal });
  for (const row of report.data.mismatches) {
    log(`${name}:row`, {
      cp: row.cpHex,
      stack: row.stackKey,
      verdict: row.verdict,
      chrome: row.chrome,
      chromeAllFaces: row.chromeAllFaces,
      chromeFile: row.chromeFile,
      ourKey: row.ourKey,
      ourPs: row.ourPostscript,
      ourFile: row.ourFile,
      ourCovered: row.ourCovered,
    });
  }
  return report;
}

describeWindows("Windows route diagnostics", () => {
  it("NX68YR: box drawing under monospace across weights", async () => {
    const cps = [0x2500, 0x2501, 0x250f, 0x254b];
    log("nx:coverage", [
      faceCoverage("consola.ttf", cps),
      faceCoverage("consolab.ttf", cps),
      faceCoverage("consolai.ttf", cps),
      faceCoverage("consolaz.ttf", cps),
      faceCoverage("l_10646.ttf", cps),
      faceCoverage("cour.ttf", cps),
      faceCoverage("courbd.ttf", cps),
    ]);
    for (const weight of [400, 700, 800, 900]) {
      for (const [base, baseFamilyName] of [
        ["Consolas", "monospace"],
        ["Consolas-Bold", "monospace"],
        ["Consolas", "Consolas"],
      ] as const) {
        const result = resolveSystemFallbackFonts(cps, base, {
          weight,
          italic: false,
          fontSize: 16,
          baseFamilyName,
          locale: "en",
        });
        log("nx:helper", { weight, base, baseFamilyName, result: Object.fromEntries(result) });
      }
    }
    const stacks = syntheticCorpus().stacks.filter(
      (s) =>
        s.fontFamily === "monospace" &&
        s.fontSize === 16 &&
        [400, 700, 800, 900].includes(s.fontWeight) &&
        s.fontStyle === "normal" &&
        s.fontStretch === "100%" &&
        s.lang == null,
    );
    expect(stacks.length).toBeGreaterThanOrEqual(4);
    await conformance("nx", stacks, cps.map((cp) => cp.toString(16)).join(","));
  }, 300_000);

  it("1EFA3S: supplementary CJK compatibility ideographs by locale and stack", async () => {
    // U+2F800 → U+4E3D, U+2F801 → U+4E38, U+2F8A6 → U+6148, U+2FA1D → U+2A600 (canonical singletons).
    const cps = [0x2f800, 0x2f801, 0x2f8a6, 0x2fa1d, 0x4e3d, 0x4e38, 0x6148, 0x2a600];
    log("cjk:coverage", [
      faceCoverage("msyh.ttc", cps),
      faceCoverage("msjh.ttc", cps),
      faceCoverage("malgun.ttf", cps),
      faceCoverage("YuGothR.ttc", cps),
      faceCoverage("simsun.ttc", cps),
      faceCoverage("simsunb.ttf", cps),
      faceCoverage("mingliub.ttc", cps),
      faceCoverage("msgothic.ttc", cps),
      faceCoverage("gulim.ttc", cps),
    ]);
    const supplementary = cps.slice(0, 4);
    for (const locale of ["zh-Hans", "zh-Hant", "ja", "ko", "en"]) {
      for (const [base, baseFamilyName] of [
        ["Impact", "fantasy"],
        ["SegoeUI", "system-ui"],
        ["TimesNewRomanPSMT", "serif"],
      ] as const) {
        const result = resolveSystemFallbackFonts(supplementary, base, {
          weight: 400,
          italic: false,
          fontSize: 16,
          baseFamilyName,
          locale,
        });
        log("cjk:helper", { locale, base, baseFamilyName, result: Object.fromEntries(result) });
      }
    }
    const stacks = syntheticCorpus().stacks.filter(
      (s) =>
        ["fantasy", "system-ui", "serif", "sans-serif"].includes(s.fontFamily) &&
        s.fontSize === 16 &&
        s.fontWeight === 400 &&
        s.fontStyle === "normal" &&
        s.fontStretch === "100%",
    );
    expect(stacks.length).toBeGreaterThanOrEqual(16);
    await conformance("cjk", stacks, supplementary.map((cp) => cp.toString(16)).join(","));
  }, 300_000);
});
