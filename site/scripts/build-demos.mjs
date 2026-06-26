// DM-1308: copy the committed demo SVGs the site embeds into public/demos/ at
// build time, so we don't duplicate large SVGs in git. Sources are the same
// artifacts the regression suites produce: examples/output (single-frame +
// composed demos), examples/output/templates (template gallery), the runnable
// animate-example goldens (examples/animate/<name>/<name>.svg), and the
// full-app captures in demo-assets/apps. Astro then serves public/ at the base.
import { cpSync, mkdirSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
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

/** Copy each examples/animate/<name>/<name>.svg golden into `dstDir` (flat). */
function copyAnimateGoldens(dstDir) {
  const root = resolve(ROOT, "examples/animate");
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const name of readdirSync(root)) {
    const dir = resolve(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const golden = resolve(dir, `${name}.svg`);
    if (existsSync(golden)) {
      cpSync(golden, resolve(dstDir, `${name}.svg`));
      n++;
    }
  }
  return n;
}

let total = 0;
// The runnable animate-example goldens (before-after-refactor, scroll-landing,
// typing-search, …) are the canonical source. Copy them FIRST so that for any
// name also produced into examples/output, the examples/output copy below wins.
total += copyAnimateGoldens(OUT);
total += copySvgs(resolve(ROOT, "examples/output"), OUT);
total += copySvgs(resolve(ROOT, "examples/output/templates"), resolve(OUT, "templates"));
// Full-application demos — real domotion captures of two live local apps,
// committed in-repo (so CI has them without those external repos checked out).
// Provenance is documented in demo-assets/apps/README.md.
total += copySvgs(resolve(HERE, "..", "demo-assets", "apps"), resolve(OUT, "apps"));

console.log(`[build-demos] copied ${total} demo SVGs → ${OUT}`);
