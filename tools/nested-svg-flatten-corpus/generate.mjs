// DM-X6GGXV: generate the design-tool import test corpus. For each SVG feature
// dimension it writes a `-nested.svg` (an outer SVG wrapping a nested `<svg>`,
// what Domotion emits by default) and, where Domotion can flatten it, a
// `-flat.svg` (the `<g transform>` form from --flatten-nested-svg). Open each
// pair in a design tool (Sketch/Figma/Illustrator/Inkscape) and record whether
// the nested form imports/renders wrong and whether the flat form fixes it —
// AND whether the tool also mishandles the extra feature (clipPath/use/style/
// filter). See README.md for the procedure + matrix template.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenImgSvg } from "../../dist/render/svg-inline.js";

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const PLACE = { x: 20, y: 20, w: 120, h: 120, par: "xMidYMid meet", idPrefix: "n" };
const outer = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">` +
  `<rect width="160" height="160" fill="#fff"/>${inner}</svg>\n`;
const nested = (bodySvg) => outer(
  `<svg x="${PLACE.x}" y="${PLACE.y}" width="${PLACE.w}" height="${PLACE.h}" ` +
  `viewBox="0 0 24 24" preserveAspectRatio="${PLACE.par}">${bodySvg}</svg>`,
);

// The source `<svg>` bodies for each dimension.
const DIMS = {
  "01-nested-only": `<path d="M2 2h20v20H2z" fill="#c33"/><circle cx="12" cy="12" r="6" fill="#39c"/>`,
  "02-clippath": `<clipPath id="c"><circle cx="12" cy="12" r="9"/></clipPath><rect width="24" height="24" fill="#c33" clip-path="url(#c)"/>`,
  "03-use-symbol": `<defs><g id="s"><rect x="2" y="2" width="8" height="8" fill="#282"/></g></defs><use href="#s"/><use href="#s" x="10" y="10"/>`,
  "04-style": `<style>.p{fill:#930}rect{stroke:#000;stroke-width:1}</style><rect class="p" x="2" y="2" width="20" height="20"/>`,
  "05-filter": `<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><circle cx="12" cy="12" r="8" fill="#39c" filter="url(#f)"/>`,
};

for (const [name, body] of Object.entries(DIMS)) {
  const fullSvg = `<svg viewBox="0 0 24 24">${body}</svg>`;
  writeFileSync(join(OUT, `${name}-nested.svg`), nested(body));
  const flat = flattenImgSvg(fullSvg, PLACE);
  if (flat != null) {
    writeFileSync(join(OUT, `${name}-flat.svg`), outer(flat));
    console.log(`${name}: nested + flat (Domotion flattens this)`);
  } else {
    console.log(`${name}: nested only (Domotion GATES this — stays a nested <svg>)`);
  }
}
