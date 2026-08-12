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
const result = spawnSync(helper, [], {
  input: JSON.stringify({ fonts: [], queries }), encoding: "utf8", windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || `helper exited ${result.status}\n`);
  process.exit(result.status ?? 2);
}
const parsed = JSON.parse(result.stdout);
for (let i = 0; i < queries.length; i++) {
  process.stdout.write(`${queries[i].label}: ${JSON.stringify(parsed.results[i])}\n`);
}
