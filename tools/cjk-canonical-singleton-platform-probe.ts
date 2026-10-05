/**
 * Focused native probe for the CJK canonical-singleton oracle rule.
 *
 * Run on a host with its production glyph helper built. The same Chromium
 * session and stack feed the fast resolver, proposed canonical walk, and real
 * shape-first splitter. A report is written before returning a mismatch exit
 * code, so hosted Windows artifacts remain inspectable when the gate fails.
 */
import { arch, platform, release } from "node:os";
import { chromium } from "@playwright/test";
import {
  isGlyphHelperAvailable,
  splitTextIntoFontRunsShaped,
  stackPrimaryIsSystemUi,
} from "@domotion/text-engine/testing";
import {
  ChromeOracle,
  cjkCanonicalCandidateFace,
  cjkCanonicalSingleton,
  faceFor,
  identifyFace,
  ourFaceFor,
  prepareStack,
  primaryChromeFace,
  type OurFace,
  type StackSpec,
} from "./font-conformance.js";
import { syntheticCorpus } from "./font-conformance-synthetic-stacks.js";
import { isMain, runMain } from "./lib/cli.js";
import { writeReport } from "./lib/report.js";

export const CJK_CANONICAL_PROBE_CODEPOINTS = [0xf900, 0xfa00, 0x2f800, 0x2f900, 0x2fa00] as const;
export const CJK_CANONICAL_PROBE_FAMILIES = ["serif", "sans-serif", "system-ui"] as const;
export const CJK_CANONICAL_PROBE_LANGUAGES = ["ja", "ko", "zh-Hans", "zh-Hant"] as const;

export function cjkCanonicalProbeStacks(): StackSpec[] {
  const stacks = syntheticCorpus().stacks;
  return CJK_CANONICAL_PROBE_FAMILIES.flatMap((fontFamily) =>
    CJK_CANONICAL_PROBE_LANGUAGES.map((lang) => {
      const spec = stacks.find(
        (candidate) =>
          candidate.fontFamily === fontFamily &&
          candidate.lang === lang &&
          candidate.fontSize === 16 &&
          candidate.fontWeight === 400 &&
          candidate.fontStyle === "normal" &&
          candidate.fontStretch === "100%",
      );
      if (spec == null) throw new Error(`missing synthetic stack ${fontFamily}/${lang}`);
      return spec;
    }),
  );
}

function faceIdentity(face: OurFace) {
  return {
    key: face.key,
    postscriptName: face.postscriptName,
    path: face.path,
    covered: face.covered,
  };
}

export function sameNativeFace(candidate: OurFace, splitter: OurFace): boolean {
  return (
    candidate.key === splitter.key &&
    candidate.postscriptName != null &&
    candidate.postscriptName === splitter.postscriptName &&
    candidate.path?.toLowerCase() === splitter.path?.toLowerCase()
  );
}

export async function collectCjkCanonicalProbe(out: string): Promise<number> {
  if (!isGlyphHelperAvailable()) throw new Error("native glyph helper is required for this probe");
  if (process.env.DOMOTION_CLUSTER_FALLBACK === "0") throw new Error("shape-first splitter must be enabled");
  const browser = await chromium.launch();
  let oracle: ChromeOracle | null = null;
  try {
    oracle = await ChromeOracle.create(browser, 8, "en");
    const rows = [];
    for (const spec of cjkCanonicalProbeStacks()) {
      const rs = prepareStack(spec);
      if (rs == null) throw new Error(`cannot prepare stack ${spec.fontFamily}/${spec.lang}`);
      const chromeFaces = await oracle.facesFor([...CJK_CANONICAL_PROBE_CODEPOINTS], spec);
      for (const [index, cp] of CJK_CANONICAL_PROBE_CODEPOINTS.entries()) {
        const chrome = primaryChromeFace(chromeFaces[index] ?? []);
        if (chrome == null)
          throw new Error(`Chrome painted no face for ${spec.fontFamily}/${spec.lang}/U+${cp.toString(16)}`);
        const fast = ourFaceFor(cp, rs, spec.lang);
        const candidate = cjkCanonicalCandidateFace(cp, rs, fast);
        const text = String.fromCodePoint(cp);
        const runs = splitTextIntoFontRunsShaped(
          text,
          rs.primary,
          rs.primaryKey,
          spec.fontWeight,
          spec.fontSize,
          rs.slant,
          undefined,
          spec.lang,
          rs.chain,
          stackPrimaryIsSystemUi(spec.fontFamily, spec.lang),
          rs.stretch,
          undefined,
          spec.fontFamily,
        );
        if (runs.length !== 1 || runs[0].text !== text) {
          throw new Error(
            `splitter did not return one source run for ${spec.fontFamily}/${spec.lang}/U+${cp.toString(16)}`,
          );
        }
        const splitter = faceFor(rs, runs[0].fontKey, true, runs[0].font);
        const candidateMatchesSplitter = sameNativeFace(candidate, splitter);
        rows.push({
          fontFamily: spec.fontFamily,
          lang: spec.lang,
          codepoint: `U+${cp.toString(16).toUpperCase()}`,
          canonical: cjkCanonicalSingleton(cp),
          chrome: {
            familyName: chrome.familyName,
            postScriptName: chrome.postScriptName ?? null,
            glyphCount: chrome.glyphCount,
          },
          fast: faceIdentity(fast),
          candidate: faceIdentity(candidate),
          splitter: { ...faceIdentity(splitter), routeMechanism: runs[0].routeMechanism ?? null },
          fastVsChrome: identifyFace(chrome, fast, false),
          candidateVsChrome: identifyFace(chrome, candidate, false),
          splitterVsChrome: identifyFace(chrome, splitter, false),
          candidateMatchesSplitter,
        });
      }
    }
    if (rows.length !== 60) throw new Error(`expected 60 cells, got ${rows.length}`);
    const summary = {
      cells: rows.length,
      fastChromeMismatches: rows.filter((row) => row.fastVsChrome == null).length,
      candidateChromeMismatches: rows.filter((row) => row.candidateVsChrome == null).length,
      splitterChromeMismatches: rows.filter((row) => row.splitterVsChrome == null).length,
      candidateSplitterMismatches: rows.filter((row) => !row.candidateMatchesSplitter).length,
    };
    writeReport(
      out,
      "cjk-canonical-singleton-platform-probe",
      { summary, rows },
      {
        schemaVersion: 1,
        env: {
          platform: platform(),
          arch: arch(),
          osRelease: release(),
          node: process.version,
          chromium: browser.version(),
          nativeGlyphHelper: true,
          sourceSha: process.env.GITHUB_SHA ?? null,
          runnerImage: process.env.ImageOS ?? null,
          runnerImageVersion: process.env.ImageVersion ?? null,
        },
      },
    );
    process.stdout.write(`${JSON.stringify(summary)}\nreport: ${out}\n`);
    return summary.splitterChromeMismatches === 0 && summary.candidateSplitterMismatches === 0 ? 0 : 1;
  } finally {
    await oracle?.close();
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  void runMain(() => collectCjkCanonicalProbe(process.argv[2] ?? "tests/output/cjk-canonical-singleton-probe.json"));
}
