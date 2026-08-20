/**
 * Exact pre-raster shaping oracle (DM-2096).
 *
 * Chromium does not expose glyph ids through CDP. This therefore asks the
 * source-equivalent question allowed by the parity contract: shape the same
 * concrete face with Domotion's Chromium-configured vendored HarfBuzz, record
 * every logical output field, and prove the comparison is sensitive with
 * deliberately wrong controls. See docs/114-exact-shaping-oracle.md.
 */
import { existsSync, writeFileSync } from "node:fs";
import { versionString, BufferFlag, ClusterLevel } from "../vendor/harfbuzzjs/dist/index.mjs";
import { harfbuzzShapeRun, harfbuzzGlyphQuery, type ShapeResult } from "../src/render/harfbuzz-shaper.js";
import { getFontInstance, platformFontKeys, shapingFaceFor } from "../src/render/font-resolution.js";
import { SHAPE_SAMPLES } from "./shape-agreement-samples.js";
import { fingerprintComplete, parityEnvironment } from "./parity-environment.js";

interface OracleGlyph {
  id: number; cluster: number; sourceSpan: [number, number];
  xAdvance: number; yAdvance: number; xOffset: number; yOffset: number;
  flags: number; unsafeToBreak: boolean;
}

const argv = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mode = argv.includes("--exhaustive") ? "exhaustive" : argv.includes("--rotating") ? "rotating" : "representative";
const output = value("--json");
const faceFilter = value("--face")?.toLowerCase();
const sizePx = Number(value("--size") ?? "16");
const zoom = Number(value("--zoom") ?? "1");
const deviceScaleFactor = Number(value("--device-scale") ?? "1");
const skipNegativeControl = argv.includes("--skip-negative-control");

function sourceEnd(text: string, cluster: number, clusters: number[]): number {
  const later = clusters.filter((c) => c > cluster);
  return later.length > 0 ? Math.min(...later) : text.length;
}

function logical(result: ShapeResult, text: string): OracleGlyph[] {
  return result.glyphs.map((g, i) => ({
    id: g.id,
    cluster: result.clusters[i],
    sourceSpan: [result.clusters[i], sourceEnd(text, result.clusters[i], result.clusters)],
    xAdvance: result.positions[i].xAdvance,
    yAdvance: result.positions[i].yAdvance,
    xOffset: result.positions[i].xOffset,
    yOffset: result.positions[i].yOffset,
    flags: result.glyphFlags[i],
    unsafeToBreak: (result.glyphFlags[i] & 1) !== 0,
  }));
}

function signature(r: ShapeResult | null): string {
  if (r == null) return "declined";
  return JSON.stringify(r.glyphs.map((g, i) => [g.id, r.clusters[i], r.positions[i], r.glyphFlags[i]]));
}

const samples = mode === "representative" ? SHAPE_SAMPLES.slice(0, 28) : SHAPE_SAMPLES;
const keys = platformFontKeys().filter((k) => faceFilter == null || k.toLowerCase().includes(faceFilter));
const records: unknown[] = [];
const controlHits = { face: 0, axes: 0, ptem: 0, features: 0, direction: 0, script: 0, language: 0, bufferFlags: 0, clusterLevel: 0 };
let pairs = 0;

for (const key of keys) {
  const face = shapingFaceFor(key, 400, sizePx, 0);
  if (face == null || face.faceIndex == null || !existsSync(face.path)) continue;
  const query = harfbuzzGlyphQuery(face.path, face.faceIndex);
  if (query == null) continue;
  for (const sample of samples) {
    if ([...sample.text].some((ch) => query.nominalGlyph(ch.codePointAt(0)!) === 0)) continue;
    const direction = sample.note.includes("vertical-form") ? "ttb" as const
      : /^(arabic|hebrew|myanmar)$/.test(sample.script) ? "rtl" as const : "ltr" as const;
    const script = sample.script === "cjk" ? "Hani" : sample.script;
    const opts = {
      script,
      language: sample.language ?? "und",
      bufferFlags: BufferFlag.BOT | BufferFlag.EOT,
      clusterLevel: ClusterLevel.MONOTONE_CHARACTERS,
    };
    const baseline = harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx, face.axes, undefined, opts);
    if (baseline == null) continue;
    pairs++;
    const baseSig = signature(baseline);
    const controls = {
      axes: face.axes == null ? null : harfbuzzShapeRun(
        face.path, face.faceIndex, sample.text, direction, sizePx,
        Object.fromEntries(Object.entries(face.axes).map(([tag, coordinate], i) => [tag, coordinate + (i === 0 ? 1 : 0)])),
        undefined, opts,
      ),
      ptem: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx * 2, face.axes, undefined, opts),
      features: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx, face.axes, ["-liga", "-kern"], opts),
      direction: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction === "rtl" ? "ltr" : "rtl", sizePx, face.axes, undefined, opts),
      script: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx, face.axes, undefined, { ...opts, script: script === "Latn" ? "Arab" : "Latn" }),
      language: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx, face.axes, undefined, { ...opts, language: opts.language === "sr" ? "und" : "sr" }),
      bufferFlags: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx, face.axes, undefined, { ...opts, bufferFlags: opts.bufferFlags | BufferFlag.PRESERVE_DEFAULT_IGNORABLES }),
      clusterLevel: harfbuzzShapeRun(face.path, face.faceIndex, sample.text, direction, sizePx, face.axes, undefined, { ...opts, clusterLevel: ClusterLevel.CHARACTERS }),
    };
    for (const name of Object.keys(controls) as Array<keyof typeof controls>) {
      if (name === "axes" && face.axes == null) continue;
      if (signature(controls[name]) !== baseSig) controlHits[name]++;
    }
    const instance = getFontInstance(key, 400, sizePx, 0);
    records.push({
      environment: parityEnvironment({
        chromium: `Playwright package-pinned; HarfBuzz ${versionString()}`, launchFlags: [], deviceScaleFactor, zoom,
        writingMode: direction === "ttb" ? "vertical-rl" : "horizontal-tb", direction,
        corpusIdentity: `shape-samples-v2:${SHAPE_SAMPLES.length}`, sampleIdentity: `${key}:${sample.note}`,
      }),
      face: {
        key, path: face.path, member: face.faceIndex,
        postscriptName: instance?.instantiatedPostscriptName ?? instance?.postscriptName ?? null,
        localPostscriptName: instance?.postscriptName ?? null,
        namedInstance: null, axes: face.axes,
      },
      input: {
        text: sample.text, utf16Span: [0, sample.text.length], direction, fontSizePx: sizePx,
        script, language: opts.language, features: [],
        bufferFlags: opts.bufferFlags, clusterLevel: opts.clusterLevel,
      },
      fallbackRuns: [{ utf16Span: [0, sample.text.length], face: `${face.path}#${face.faceIndex}` }],
      glyphs: logical(baseline, sample.text),
      rasterization: "out-of-scope",
    });
  }
}

// A distinct covering face is an additional mandatory negative control.
if (records.length > 0) {
  const first = records[0] as { face: { path: string; member: number }; input: { text: string; direction: "ltr" | "rtl" | "ttb" | "btt" }; glyphs: OracleGlyph[] };
  for (const key of keys) {
    const alt = shapingFaceFor(key, 400, sizePx, 0);
    if (alt == null || alt.faceIndex == null || `${alt.path}#${alt.faceIndex}` === `${first.face.path}#${first.face.member}`) continue;
    const q = harfbuzzGlyphQuery(alt.path, alt.faceIndex);
    if (q == null || [...first.input.text].some((ch) => q.nominalGlyph(ch.codePointAt(0)!) === 0)) continue;
    const r = harfbuzzShapeRun(alt.path, alt.faceIndex, first.input.text, first.input.direction, sizePx, alt.axes);
    if (signature(r) !== JSON.stringify(first.glyphs.map((g) => [g.id, g.cluster, { xAdvance: g.xAdvance, yAdvance: g.yAdvance, xOffset: g.xOffset, yOffset: g.yOffset }, g.flags]))) controlHits.face++;
    break;
  }
}

const required = ["face", "axes", "ptem", "features", "direction", "script", "language", "bufferFlags", "clusterLevel"] as const;
const missed = required.filter((k) => controlHits[k] === 0);
const completeEnvironment = records.every((r) => fingerprintComplete((r as { environment: unknown }).environment));
const movementProven = !skipNegativeControl && missed.length === 0;
const verdict = !completeEnvironment || !movementProven ? "verdict-withheld"
  : pairs > 0 ? "exact-logical-agreement" : "logical-mismatch";
const report = { schemaVersion: 2, stage: "shaping", mode, verdict, completeEnvironment, movementProven, pairs, controlHits, missedControls: missed, records };
if (output != null) writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Exact shaping oracle: ${pairs} face×sample pairs; controls ${JSON.stringify(controlHits)}`);
if (output != null) console.log(`wrote ${output}`);
if (pairs === 0 || !completeEnvironment || !movementProven) {
  console.error(`Oracle sensitivity failure: ${pairs === 0 ? "no comparable pairs" : `no delta for ${missed.join(", ")}`}`);
  process.exitCode = 1;
}
