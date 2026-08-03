/**
 * Shaper A/B: our two shapers against each other, at glyph-ID granularity.
 *
 * ## Where this sits
 *
 * Two oracles already exist and both ask CHROME:
 *
 *   `tools/font-conformance.ts`     which FACE Chrome picks for a codepoint
 *   `tools/shaping-conformance.ts`  Chrome's glyph COUNT per face plus
 *                                   per-character geometry from client rects
 *
 * Both are bounded by what CDP exposes, and CDP exposes no glyph-level domain:
 * `CSS.getPlatformFontsForNode` carries familyName / postScriptName /
 * isCustomFont / glyphCount and nothing more. So neither can see WHICH glyph, or
 * where a mark was attached within a cluster.
 *
 * This tool asks a different question that does not need Chrome to answer it.
 * Domotion runs three shapers where Chrome runs one — fontkit's `layout()`, the
 * macOS CoreText helper's `shape` query, and HarfBuzz. Since `vendor/harfbuzzjs/`
 * is built from Chromium's own HarfBuzz configuration (same 14.2.1 release, same
 * defines), HarfBuzz is not merely the same library Chrome uses but the same
 * build. That makes it a usable local reference, and the question becomes: how
 * far is the platform shaper from it?
 *
 * The claim it supports is therefore narrower than the oracles' and sharper:
 * not "we match Chrome", but "our non-HarfBuzz shaper differs from Chrome's
 * HarfBuzz HERE, in THIS way, on THESE glyphs". Where that surfaces something,
 * confirming it against Chrome is a separate step — `hb-shape` and a rendered
 * pixel comparison, per case.
 *
 * ## What it compares
 *
 * For each (face, sample text) pair: glyph ids, advances, offsets and the
 * source-cluster map, in FONT UNITS on both sides. The helper is opened at
 * `size = unitsPerEm` precisely so its output is design-unit space
 * (`glyph-helper.ts` — "so all glyph paths come back in design-unit space"),
 * which is what HarfBuzz reports natively. No scaling is applied to either
 * side; a units mismatch would show up as a total mismatch rather than a
 * plausible small one.
 *
 * Disagreement is reported by KIND, because the kinds mean different things:
 *
 *   glyph-count   different number of glyphs — a substitution one side did not
 *                 apply at all (joining, a ligature, a decomposition)
 *   glyph-ids     same count, different glyphs — the wrong forms
 *   advance       same glyphs, different widths — a kerning or tracking source
 *   offset        same glyphs and widths, different placement — GPOS marks
 *   cluster       same output, different source mapping — affects anchoring
 *
 * A glyph-count or glyph-ids disagreement is a visibly different word. An
 * offset disagreement is the class of bug that reads as "antialiasing" in a
 * pixel diff and is not.
 *
 * **Read the kinds, not the total.** Measured across the vendored-HarfBuzz
 * change: the total moved 217 -> 222, i.e. very slightly WORSE, while
 * glyph-count fell 34 -> 9 and glyph-ids 8 -> 1. Structural disagreement — the
 * "different word" classes — dropped by three quarters, and the total rose only
 * because an AAT-capable build now emits offsets where it previously emitted
 * none, giving more to compare. A headline number would have reported that
 * improvement as a regression.
 *
 * ## Usage
 *
 *   npm run fonts:shaper-ab -- [--json out.json] [--face <substr>]
 *                              [--verbose] [--max-report N]
 *
 * Exits non-zero when any pair disagrees, so it can gate. `--face` narrows to
 * faces whose key contains a substring — useful while iterating, and dangerous
 * as a conclusion: a narrowed run cannot support a corpus-wide claim.
 *
 * ## The total does not move when a script is rerouted, and that is not a bug
 *
 * Both sides are called DIRECTLY here, so the headline count measures how far
 * apart the two ENGINES are and is unmoved by which of them production routes a
 * script to (see the note in `comparePair`). A reroute therefore cannot make it
 * fall, and reading a flat total as "the change did nothing" would be exactly
 * backwards.
 *
 * What does move is the count of disagreements that can still REACH PAINT. A
 * sample whose script is in `HARFBUZZ_SHAPED_RANGES` is shaped by HarfBuzz on
 * both sides in production, so its disagreements are recorded and then set
 * aside. That derived number — printed as `reaching production` — is the one to
 * quote when a script moves, and it is attributable because the per-script
 * breakdown says which script accounts for the drop.
 */import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { harfbuzzShapeRun } from "../src/render/harfbuzz-shaper.js";
import { createGlyphHelperFont, isGlyphHelperAvailable } from "../src/render/glyph-helper.js";
import { resolveFontSpec, shapingFaceFor, platformFontKeys } from "../src/render/font-resolution.js";
import { usesHarfbuzzShaping } from "../src/render/unicode-classification.js";
import { SHAPE_SAMPLES } from "./shape-agreement-samples.js";

interface Disagreement {
  face: string;
  path: string;
  faceIndex: number;
  sample: string;
  script: string;
  text: string;
  kind: "glyph-count" | "glyph-ids" | "advance" | "offset" | "cluster";
  hb: string;
  ct: string;
}

/** Font-unit tolerance, applied after rounding both sides to whole units.
 *
 * HarfBuzz reports positions as INTEGER font units when the font is scaled to
 * unitsPerEm, so a sub-unit difference is not something it can express — the
 * quantisation happens inside the engine, not in this comparison. CoreText
 * returns floats (`724.9` where HarfBuzz says `725`). Comparing them raw makes
 * every interpolated variable face a "disagreement" at 0.5 units, which is a
 * property of the two APIs' return types and not of their shaping.
 *
 * So both sides are rounded to whole units first, and then required to be
 * EQUAL. Worth being clear about the cost: this cannot see a genuine sub-unit
 * disagreement. At 16 px on a 1000-upem face one unit is 0.016 px, so nothing
 * it hides is visible — but a systematic sub-unit bias that accumulated across
 * a long run would slip through, and that is a real blind spot rather than a
 * safe one. */
const UNIT_EPS = 0;
/** Round to whole font units, so the two APIs' return types stop being a diff. */
const u = (n: number): number => Math.round(n);

/** Every font key this platform's table declares that actually resolves to a
 *  file present on THIS host. Keys are skipped silently when the font is not
 *  installed — that is a coverage fact, reported in the summary, not an error. */
function resolvableFaces(filter: string | null, sizePx: number, weight: number): Array<{ key: string; path: string; faceIndex: number; axes: Record<string, number> | null; weight: number }> {
  const out: Array<{ key: string; path: string; faceIndex: number; axes: Record<string, number> | null; weight: number }> = [];
  for (const key of platformFontKeys()) {
    if (filter != null && !key.toLowerCase().includes(filter.toLowerCase())) continue;
    let face: { path: string; faceIndex: number | null; axes: Record<string, number> | null } | null = null;
    try {
      face = shapingFaceFor(key, weight, sizePx, 0);
    } catch {
      continue;
    }
    if (face == null || face.faceIndex == null) continue;
    if (!existsSync(face.path)) continue;
    out.push({ key, path: face.path, faceIndex: face.faceIndex, axes: face.axes, weight });
  }
  return out;
}

/** Whether a face covers every codepoint of a sample. A face that does not
 *  cover the text would shape to `.notdef` on one side and trigger CoreText's
 *  own font substitution on the other — comparing those two is comparing
 *  fallback policy, not shaping, so such pairs are excluded rather than
 *  counted as disagreements. */
function covers(font: NonNullable<ReturnType<typeof createGlyphHelperFont>>, text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    const g = font.glyphForCodePoint(cp);
    if (g == null || g.id === 0) return false;
  }
  return true;
}

function comparePair(
  face: { key: string; path: string; faceIndex: number; axes: Record<string, number> | null; weight: number },
  sample: { script: string; text: string; note?: string },
  font: NonNullable<ReturnType<typeof createGlyphHelperFont>>,
): Disagreement[] {
  // Shape at ptem = unitsPerEm, because that is the size the CoreText helper
  // opens the face at, and AAT `trak` tracking is size-dependent. Matching it
  // holds the ONE known, separately-tracked difference constant so everything
  // else is visible; leaving ptem unset would report every `trak` face as an
  // advance disagreement and drown the rest.
  //
  // Note what this therefore CANNOT catch: whether either side uses the size
  // Chrome uses. It does not — Blink passes the CSS pixel size, and neither
  // path here does. That is a real defect, and this tool is deliberately blind
  // to it, so it must not be read as evidence of tracking parity with Chrome.
  //
  // Nor is it evidence about which engine the RENDER PIPELINE routes a face to.
  // Both sides are called directly here, so the count is unmoved by a routing
  // change — including the one that sends `trak` + `STAT` faces' shaping to
  // HarfBuzz. This measures how far apart the two engines are, not which of
  // them paint reaches.
  const hb = harfbuzzShapeRun(face.path, face.faceIndex, sample.text, undefined, font.unitsPerEm, face.axes);
  if (hb == null) return []; // HarfBuzz declined the face — nothing to compare
  const ct = font.layout(sample.text);
  const base = { face: `${face.key}@${face.weight}`, path: face.path, faceIndex: face.faceIndex, sample: sample.note ?? sample.script, script: sample.script, text: sample.text };

  if (hb.glyphs.length !== ct.glyphs.length) {
    return [{ ...base, kind: "glyph-count", hb: `${hb.glyphs.length} glyphs`, ct: `${ct.glyphs.length} glyphs` }];
  }
  const out: Disagreement[] = [];
  const hbIds = hb.glyphs.map((g) => g.id);
  const ctIds = ct.glyphs.map((g) => g.id);
  if (hbIds.join(",") !== ctIds.join(",")) {
    out.push({ ...base, kind: "glyph-ids", hb: hbIds.join(" "), ct: ctIds.join(" ") });
    // Positions of different glyphs are not a meaningful comparison.
    return out;
  }
  const advDiff = hb.positions.some((p, i) => Math.abs(u(p.xAdvance) - u(ct.positions[i].xAdvance)) > UNIT_EPS);
  if (advDiff) {
    out.push({ ...base, kind: "advance", hb: hb.positions.map((p) => p.xAdvance).join(" "), ct: ct.positions.map((p) => p.xAdvance).join(" ") });
  }
  const offDiff = hb.positions.some(
    (p, i) => Math.abs(u(p.xOffset) - u(ct.positions[i].xOffset)) > UNIT_EPS || Math.abs(u(p.yOffset) - u(ct.positions[i].yOffset)) > UNIT_EPS,
  );
  if (offDiff) {
    const fmt = (ps: Array<{ xOffset: number; yOffset: number }>): string => ps.map((p) => `${p.xOffset},${p.yOffset}`).join(" ");
    out.push({ ...base, kind: "offset", hb: fmt(hb.positions), ct: fmt(ct.positions) });
  }
  if (ct.clusters != null && hb.clusters.join(",") !== ct.clusters.join(",")) {
    out.push({ ...base, kind: "cluster", hb: hb.clusters.join(" "), ct: ct.clusters.join(" ") });
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const jsonOut = arg("--json");
  const filter = arg("--face");
  const verbose = argv.includes("--verbose");
  const maxReport = Number(arg("--max-report") ?? "40");

  if (!isGlyphHelperAvailable()) {
    // Not a silent skip: on a platform with no `shape` helper there is no B side
    // and the tool measures nothing. Saying so beats reporting 0 disagreements.
    console.error(`No native glyph helper with a shape query on ${process.platform} — nothing to compare against.`);
    console.error("This tool currently measures the macOS CoreText path. On other platforms the shaper is fontkit,");
    console.error("which needs a different B side (see the ticket).");
    process.exit(2);
  }

  // Both weights, not just 400. A family's cut stops being its base entry at
  // 700, and a weight-400-only sweep has already produced a blind-but-plausible
  // number in this project once (0.488% against 14.77% on the same platform,
  // differing only in which stacks were swept). Sweeping 400 alone would also
  // ask a `-bold` key at a weight nothing ever requests of it, manufacturing
  // disagreements that say nothing about production.
  //
  // 1000 stands in for the size the CoreText helper opens faces at
  // (unitsPerEm), so both sides resolve the same optical-size axis.
  const faces = [...resolvableFaces(filter, 1000, 400), ...resolvableFaces(filter, 1000, 700)];
  const disagreements: Disagreement[] = [];
  let pairs = 0;
  let skippedCoverage = 0;
  let declined = 0;
  const facesUsed = new Set<string>();
  const scriptsUsed = new Set<string>();

  for (const face of faces) {
    const spec = resolveFontSpec(face.key);
    let font: NonNullable<ReturnType<typeof createGlyphHelperFont>>;
    try {
      // Open the CoreText side at the SAME axis location the HarfBuzz side gets.
      // Omitting it is not neutral: on a variable face HarfBuzz would then be
      // instanced at the resolved location while CoreText sat at whatever the
      // PostScript name resolves to, and the resulting advance gap would be
      // reported as an engine disagreement. Measured before this was passed: 57
      // disagreements on the 13 macOS faces carrying `trak` + `STAT` (SF Pro,
      // SF Compact, SF Hebrew, the PingFang cuts), 52 of them `advance` — on
      // exactly the faces that are variable, and with tracking already held
      // equal by the shared `ptem` below, so they could not have been tracking.
      //
      // `face.axes` (the `resolveAxisLocationForFile` derivation) rather than
      // the `resolveDarwinAxisLocation` one `getFontInstance` opens the helper
      // with, deliberately: it names EVERY axis explicitly, so both engines are
      // pinned to the same point instead of one of them resolving a location
      // from a name. Production's asymmetry between those two derivations is a
      // routing fact, and routing is not what this tool measures.
      const f = createGlyphHelperFont({
        postscriptName: spec?.postscriptName, fontPath: face.path,
        variations: face.axes ?? undefined,
      });
      if (f == null) continue;
      font = f;
    } catch {
      continue;
    }
    if (harfbuzzShapeRun(face.path, face.faceIndex, "A", undefined, 1000, face.axes) == null && harfbuzzShapeRun(face.path, face.faceIndex, SHAPE_SAMPLES[0].text, undefined, 1000, face.axes) == null) {
      declined++;
      continue;
    }
    for (const sample of SHAPE_SAMPLES) {
      if (!covers(font, sample.text)) {
        skippedCoverage++;
        continue;
      }
      pairs++;
      facesUsed.add(`${face.key}@${face.weight}`);
      scriptsUsed.add(sample.script);
      const d = comparePair(face, sample, font);
      disagreements.push(...d);
      if (verbose && d.length === 0) console.log(`  ok  ${face.key} · ${sample.script}`);
    }
  }

  const byKind: Record<string, number> = {};
  for (const d of disagreements) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  const byScript: Record<string, number> = {};
  for (const d of disagreements) byScript[d.script] = (byScript[d.script] ?? 0) + 1;
  // A disagreement is set aside when production shapes that text with HarfBuzz
  // on both sides — the engines still differ, but the platform one is no longer
  // in the loop for it. `some` rather than `every` because a sample is one
  // script's text: if any of its codepoints is rerouted, the run is.
  const routed = disagreements.filter((d) => [...d.text].some((c) => usesHarfbuzzShaping(c.codePointAt(0)!)));
  const reaching = disagreements.length - routed.length;

  console.log("");
  console.log(`Shape agreement — HarfBuzz (Chromium config) vs ${process.platform === "darwin" ? "CoreText" : "platform helper"}`);
  console.log(`  faces in table:      ${platformFontKeys().length}${filter != null ? ` (filtered to "${filter}")` : ""}`);
  console.log(`  faces resolvable:    ${faces.length}`);
  console.log(`  face×weight compared:${facesUsed.size}   (${declined} declined by HarfBuzz)`);
  console.log(`  scripts exercised:   ${scriptsUsed.size} of ${new Set(SHAPE_SAMPLES.map((x) => x.script)).size}`);
  console.log(`  pairs compared:      ${pairs}   (${skippedCoverage} skipped: face does not cover the sample)`);
  console.log(`  disagreements:       ${disagreements.length}`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${kind.padEnd(12)} ${n}`);
  }
  console.log(`  reaching production: ${reaching}   (${routed.length} in scripts routed to HarfBuzz)`);
  console.log("  by script:");
  for (const [script, n] of Object.entries(byScript).sort((a, b) => b[1] - a[1])) {
    const isRouted = [...(SHAPE_SAMPLES.find((s) => s.script === script)?.text ?? "")].some((c) => usesHarfbuzzShaping(c.codePointAt(0)!));
    console.log(`      ${script.padEnd(12)} ${String(n).padStart(4)}${isRouted ? "   → HarfBuzz" : ""}`);
  }

  if (disagreements.length > 0) {
    console.log("");
    for (const d of disagreements.slice(0, maxReport)) {
      console.log(`  ${d.kind}  ${d.face} · ${d.script}  "${d.text}"`);
      console.log(`      hb: ${d.hb}`);
      console.log(`      ct: ${d.ct}`);
    }
    if (disagreements.length > maxReport) console.log(`  … and ${disagreements.length - maxReport} more (use --json for all)`);
  }

  if (jsonOut != null) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          platform: process.platform,
          filter,
          facesResolvable: faces.length,
          facesCompared: facesUsed.size,
          declined,
          pairs,
          skippedCoverage,
          byKind,
          byScript,
          reachingProduction: reaching,
          routedToHarfbuzz: routed.length,
          disagreements,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${jsonOut}`);
  }

  console.log("");
  process.exit(disagreements.length > 0 ? 1 : 0);
}

main();
