// DM-1308: copy the served brand icons from src/assets (the single source of
// truth, which the maintainer edits) into public/ at build time. Starlight's
// `favicon` option and any `<link rel="mask-icon">` resolve to files under the
// site base, i.e. they must live in public/ — but the logo is imported from
// src/assets and Astro-processed. Keeping the originals in src/assets and
// copying here means editing src/assets/*.svg is all that's needed; the public
// copies are generated (gitignored).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src", "assets");
const PUB = resolve(HERE, "..", "public");

mkdirSync(PUB, { recursive: true });

// Served at the site root (under the base) → must be in public/.
const SERVED = ["favicon.svg", "mask-icon.svg"];
let n = 0;
for (const f of SERVED) {
  const src = resolve(SRC, f);
  if (!existsSync(src)) {
    console.warn(`[build-icons] missing src/assets/${f} — skipping`);
    continue;
  }
  copyFileSync(src, resolve(PUB, f));
  n++;
}
console.log(`[build-icons] copied ${n} icon(s) → ${PUB}`);
