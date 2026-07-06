#!/usr/bin/env tsx
// CI-side font-environment diagnostic. Dumps what Domotion's resolver actually
// does for the SF/system stack ON THIS MACHINE — used to explain why the
// GitHub macos runner's Domotion output diverges from Chromium's (it appears to
// fall off SF Pro to a Helvetica-like fallback for ordinary text, while
// CI-Chrome uses SF Pro). Every line is prefixed FONTPROBE: for easy grep from
// the Actions job log. Run: `npx tsx tools/font-env-probe.mjs`.
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import {
  resolveFontSpec,
  resolveFontKeyChain,
  getFontInstance,
  __resolveSystemFallbackKeyForCpForTest as ctResolve,
} from "../src/render/font-resolution.js";

const P = (s) => console.log(`FONTPROBE: ${s}`);

P(`platform=${process.platform} arch=${process.arch} release=${os.release()}`);

// 1. Does Domotion's `sf-pro` key resolve to a file that EXISTS + LOADS here?
const sfSpec = resolveFontSpec("sf-pro");
P(`sf-pro spec path = ${sfSpec?.path ?? "(null)"}`);
P(`sf-pro path exists = ${sfSpec?.path ? existsSync(sfSpec.path) : "n/a"}`);
const sfInst = getFontInstance("sf-pro", 400, 32);
P(`getFontInstance("sf-pro") = ${sfInst ? "LOADED" : "NULL (falls through the chain!)"}`);
if (sfInst) {
  for (const cp of [0x41, 0x2c, 0x61, 0x1f130]) {
    P(`  sf-pro covers U+${cp.toString(16).toUpperCase()} = ${sfInst.glyphForCodePoint(cp).id !== 0}`);
  }
}

// 2. The fixture's actual font stack → key chain → which key each cp lands on.
const css = `"SF Pro Text","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`;
const chain = resolveFontKeyChain(css);
P(`fixture key chain = ${JSON.stringify(chain)}`);
for (const key of chain) {
  const spec = resolveFontSpec(key);
  const inst = getFontInstance(key, 400, 32);
  P(`  chain key ${key}: path=${spec?.path?.split("/").pop() ?? "(dynamic)"} exists=${spec?.path ? existsSync(spec.path) : "?"} loaded=${!!inst} covers','=${inst ? inst.glyphForCodePoint(0x2c).id !== 0 : "?"}`);
}

// 3. What does CoreText (what Chromium paints) cascade the comma / letters to?
for (const cp of [0x2c, 0x41, 0x61, 0x1f130]) {
  P(`CoreText resolve U+${cp.toString(16).toUpperCase()} = ${ctResolve(cp) ?? "(null)"}`);
}

// 4. What SF / system font files are actually present on this machine?
for (const dir of ["/System/Library/Fonts", "/Library/Fonts", "/System/Library/Fonts/Supplemental"]) {
  try {
    const sf = readdirSync(dir).filter((f) => /SF|SFNS|Helvetica|\.ttc$|SFPro/i.test(f) && /SF|Helvetica/i.test(f));
    P(`${dir}: ${sf.join(", ") || "(no SF/Helvetica files)"}`);
  } catch { P(`${dir}: (unreadable)`); }
}
