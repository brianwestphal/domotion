// DM-1308: copy the committed demo SVGs the site embeds into public/demos/ at
// build time, so we don't duplicate large SVGs in git. Sources are the same
// artifacts the regression suites produce (examples/output + the gallery copies
// under the legacy site/assets/img). Astro then serves public/ at the site base.
import { cpSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", ".."); // repo root
const OUT = resolve(HERE, "..", "public", "demos");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(resolve(OUT, "templates"), { recursive: true });

/** Copy every *.svg in `srcDir` into `dstDir` (flat). */
function copySvgs(srcDir, dstDir) {
  if (!existsSync(srcDir)) return 0;
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".svg")) continue;
    cpSync(resolve(srcDir, f), resolve(dstDir, f));
    n++;
  }
  return n;
}

let total = 0;
total += copySvgs(resolve(ROOT, "examples/output"), OUT);
total += copySvgs(resolve(ROOT, "examples/output/templates"), resolve(OUT, "templates"));
// The animate gallery goldens (typing-search, tab-switcher, form-fill, …).
total += copySvgs(resolve(ROOT, "site/assets/img/demos"), OUT);

console.log(`[build-demos] copied ${total} demo SVGs → ${OUT}`);
