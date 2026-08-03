// Rebuild `tests/fixtures/variable-axis/variable-axis.html` — the fixture that
// drives a LIVE variable axis.
//
// WHY IT EXISTS
//   The face conformance oracle (docs/107) is name-blind to variable instances:
//   one PostScript name covers every point in the design space, so two runs
//   instanced at different axis locations report the SAME face and score
//   `agree-exact`. That blindness is documented and structural — the
//   name-independent check is supposed to be the shaping oracle (docs/108),
//   which compares painted glyph positions.
//
//   Until this fixture, that pairing was an argument rather than a measurement.
//   Nothing in either corpus exercised an axis Chrome actually honors: macOS
//   Helvetica has no `wdth` axis at all, and Chrome's painted width for
//   `sans-serif` is identical at every `font-stretch` from 50% to 200% and
//   unchanged across `"wght" 100` <-> `"wght" 900` — including on `system-ui`,
//   whose SFNS file IS variable. So the blindness was untested rather than
//   passing.
//
//   A WEBFONT settles it: an `@font-face` whose file carries real `fvar`/`gvar`
//   tables, declared at several `font-variation-settings` locations on one page.
//   `tools/variable-axis-oracle-pair.ts` measures both oracles against it.
//
// UPSTREAM SOURCE (SIL Open Font License 1.1 — the license ships next to the
// fixture; the font is not modified beyond subsetting)
//   Open Sans, variable, axes wght [300..800] and wdth [75..100]
//     https://raw.githubusercontent.com/google/fonts/main/ofl/opensans/OpenSans%5Bwdth,wght%5D.ttf
//   License
//     https://raw.githubusercontent.com/google/fonts/main/ofl/opensans/OFL.txt
//
//   Open Sans was chosen for one property the fixture depends on: it carries
//   BOTH a weight and a width axis, so the fixture can drive an axis that moves
//   advances a lot (`wdth`) and one that moves them subtly (`wght`) out of a
//   single file and a single PostScript name.
//
// USAGE
//   curl -sLo /tmp/OpenSans-var.ttf <url above>
//   curl -sLo /tmp/OFL-opensans.txt <license url above>
//   node tools/build-variable-axis-fixture.mjs /tmp/OpenSans-var.ttf /tmp/OFL-opensans.txt
//
// The subset is deterministic — same input font, same harfbuzzjs, same bytes —
// so re-running this must leave `git status` clean unless the input or the
// charset below actually changed.
//
// NOTE the subset is NOT instanced. `hbSubsetRetainGids(..., pinAxes = null)`
// leaves `fvar`/`gvar` in place, which is the entire point: an instanced subset
// would have no axis to drive.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { hbSubsetRetainGids } from "../dist/render/hb-subset.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "tests/fixtures/variable-axis");

/** The CSS family the fixture declares. Deliberately not a real family name:
 *  it must not collide with anything installed, or the fixture could measure a
 *  system face and still look like it worked. */
export const FIXTURE_FAMILY = "DomotionVarAxis";

/**
 * One word, no whitespace, discriminative letterforms.
 *
 * Whitespace-free is required rather than tidy: the shaping oracle's corpus
 * excludes runs containing whitespace, because Chrome's `glyphCount` includes
 * space glyphs and our renderer usually emits no position for them (docs/108).
 * A fixture with a space in it could not be compared by the instrument it
 * exists to exercise.
 */
export const FIXTURE_TEXT = "Hamburgefonstiv";

/**
 * The axis locations the fixture paints, and what each one is for.
 *
 * `settings` goes verbatim into `font-variation-settings`. `base` is the
 * default instance; the other two are the same file at a different point in the
 * design space, carrying the same PostScript name — which is precisely what the
 * face oracle cannot tell apart.
 */
export const INSTANCES = [
  { id: "base", settings: "normal", label: "default instance (wght 400, wdth 100)" },
  { id: "wght800", settings: '"wght" 800', label: "weight axis at its maximum" },
  { id: "wdth75", settings: '"wdth" 75', label: "width axis at its minimum" },
];

function build(fontPath, licensePath) {
  const src = readFileSync(fontPath);
  const face = fontkit.create(src);
  const axes = face.variationAxes ?? {};
  if (Object.keys(axes).length === 0) {
    throw new Error(`${fontPath} exposes no variation axes — this fixture is meaningless without them`);
  }
  for (const m of INSTANCES.flatMap((i) => [...i.settings.matchAll(/"([A-Za-z0-9]{4})"\s*([-\d.]+)/g)])) {
    const [, tag, value] = m;
    const axis = axes[tag];
    if (axis == null) throw new Error(`fixture asks for axis "${tag}", which ${fontPath} does not expose`);
    const v = Number(value);
    if (v < axis.min || v > axis.max) {
      throw new Error(`fixture asks for "${tag}" ${v}, outside this font's [${axis.min}..${axis.max}]`);
    }
    if (v === axis.default) {
      throw new Error(`fixture asks for "${tag}" ${v}, which IS the default — that instance would not move anything`);
    }
  }

  const gids = new Set([0]); // .notdef
  for (const ch of new Set(FIXTURE_TEXT)) {
    const g = face.glyphForCodePoint(ch.codePointAt(0));
    if (g == null || g.id === 0) throw new Error(`source font has no glyph for ${JSON.stringify(ch)}`);
    gids.add(g.id);
  }
  const subset = hbSubsetRetainGids(src, [...gids].sort((a, b) => a - b), 0, true, null);

  // The subset must still be variable, and must still report ONE name. Both are
  // load-bearing: an instanced subset has no axis to drive, and a subset that
  // somehow renamed itself per instance would defeat the blindness the fixture
  // is built to demonstrate.
  const subFace = fontkit.create(subset);
  const subAxes = subFace.variationAxes ?? {};
  for (const tag of Object.keys(axes)) {
    if (subAxes[tag] == null) throw new Error(`subsetting dropped the "${tag}" axis — the fixture would be inert`);
  }

  const b64 = subset.toString("base64");
  const axisSummary = Object.entries(subAxes)
    .map(([tag, a]) => `${tag} [${a.min}..${a.max}] default ${a.default}`).join(", ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Variable axis fixture — one face, three instances</title>
<!--
  GENERATED by tools/build-variable-axis-fixture.mjs. Do not edit by hand.

  One @font-face, three font-variation-settings locations. The face is
  ${subFace.postscriptName} at every one of them, which is exactly why a
  face-identity oracle cannot tell the three apart and a geometry oracle can.

  Source: Open Sans (variable), SIL OFL 1.1 — see LICENSE-open-sans.txt.
  Subset to the ${gids.size} glyphs this page paints, hinting and fvar/gvar kept.
  Axes: ${axisSummary}
-->
<style>
  @font-face {
    font-family: "${FIXTURE_FAMILY}";
    src: url(data:font/ttf;base64,${b64}) format("truetype");
  }
  body { margin: 0; background: #fff; color: #000; }
  .run {
    font-family: "${FIXTURE_FAMILY}";
    font-size: 48px;
    line-height: 1.4;
    white-space: pre;
  }
${INSTANCES.map((i) => `  #${i.id} { font-variation-settings: ${i.settings}; }`).join("\n")}
</style>
</head>
<body>
${INSTANCES.map((i) => `<div class="run" id="${i.id}" data-settings='${i.settings}'>${FIXTURE_TEXT}</div>`).join("\n")}
</body>
</html>
`;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "variable-axis.html"), html);
  writeFileSync(join(OUT_DIR, "LICENSE-open-sans.txt"), readFileSync(licensePath));
  process.stdout.write(
    `wrote ${join(OUT_DIR, "variable-axis.html")}\n`
    + `  face        ${subFace.postscriptName} (family ${JSON.stringify(subFace.familyName)})\n`
    + `  axes        ${axisSummary}\n`
    + `  glyphs      ${gids.size}\n`
    + `  font bytes  ${subset.length} (${b64.length} base64)\n`
    + `  instances   ${INSTANCES.map((i) => `${i.id}=${i.settings}`).join(", ")}\n`,
  );
}

const [fontPath, licensePath] = process.argv.slice(2);
if (fontPath == null || licensePath == null) {
  process.stderr.write("usage: node tools/build-variable-axis-fixture.mjs <variable-font.ttf> <OFL.txt>\n");
  process.exitCode = 2;
} else {
  build(fontPath, licensePath);
}
