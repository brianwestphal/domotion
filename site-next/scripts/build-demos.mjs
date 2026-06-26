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
mkdirSync(resolve(OUT, "apps"), { recursive: true });

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
// The animate gallery goldens (typing-search, tab-switcher, form-fill, …) live
// only in the legacy site/assets mirror. Copy them FIRST so that for any name
// that also exists in examples/output (e.g. terminal-onboarding), the canonical
// freshly-generated examples/output copy below wins over the legacy mirror.
total += copySvgs(resolve(ROOT, "site/assets/img/demos"), OUT);
total += copySvgs(resolve(ROOT, "examples/output"), OUT);
total += copySvgs(resolve(ROOT, "examples/output/templates"), resolve(OUT, "templates"));
// Full-application demos — real domotion captures of two live local apps,
// committed in-repo (so CI has them without those external repos checked out).
// Provenance is documented in demo-assets/apps/README.md.
total += copySvgs(resolve(HERE, "..", "demo-assets", "apps"), resolve(OUT, "apps"));

console.log(`[build-demos] copied ${total} demo SVGs → ${OUT}`);
