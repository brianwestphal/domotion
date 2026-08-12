#!/usr/bin/env node
/** Focused DM-2083 DirectWrite discriminator; run on a native Windows host. */
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  process.stderr.write("win32-fallback-probe requires a native Windows host\n");
  process.exit(2);
}

const helper = "tools/win32-glyph-extractor/domotion-glyph-paths.exe";
const queries = [
  { label: "hardcoded-terminal", type: "fallback", cps: [0x2100, 0x2e00], baseFamilyName: "Times New Roman", locale: "en-us", diagnostics: true },
  { label: "calibri-italic-cut", type: "fallback", cps: [0xa700], baseFamilyName: "Calibri", locale: "en-us", italic: true, diagnostics: true },
  { label: "segoe-italic-cut", type: "fallback", cps: [0x1df00], baseFamilyName: "Segoe UI", locale: "en-us", italic: true, diagnostics: true },
];
function call(envelope) {
  const result = spawnSync(helper, [], {
    input: JSON.stringify(envelope), encoding: "utf8", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `helper exited ${result.status}\n`);
    process.exit(result.status ?? 2);
  }
  return JSON.parse(result.stdout);
}
const parsed = call({ fonts: [], queries });
for (let i = 0; i < queries.length; i++) {
  process.stdout.write(`${queries[i].label}: ${JSON.stringify(parsed.results[i])}\n`);
}

// Blink's hardcoded stage accepts a candidate through
// `CreateSkFont().unicharToGlyph`, not through DirectWrite MapCharacters. Open
// the exact family cuts that Domotion currently accepts and ask the helper's
// native glyph-index path, so a fontkit-vs-Skia coverage disagreement is visible.
for (const probe of [
  { label: "lucida-hardcoded-coverage", family: "Lucida Sans Unicode", cp: 0x2100 },
  { label: "tahoma-hardcoded-coverage", family: "Tahoma", cp: 0x2e00 },
]) {
  const family = call({ fonts: [], queries: [{ type: "family", name: probe.family }] }).results[0];
  if (!family.found) {
    process.stdout.write(`${probe.label}: family-not-found\n`);
    continue;
  }
  const glyph = call({
    fonts: [{ ref: "candidate", fontPath: family.path, postscriptName: family.postscriptName, size: 2048 }],
    queries: [{ type: "glyphs", fontRef: "candidate", glyphs: [{ cp: probe.cp }] }],
  }).results[0].glyphs[0];
  process.stdout.write(`${probe.label}: ${JSON.stringify({ family, cp: probe.cp, glyphId: glyph.id })}\n`);
}
