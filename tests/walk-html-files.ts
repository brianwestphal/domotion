// DM-714 / DM-1230: recursively collect the `*.html` fixture paths under a
// visual-suite root. Extracted from `html-test-suite.tsx` so it can be unit
// tested without importing the harness (which runs the whole suite on import).
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Walk `rootDir` recursively. Returns relative paths with `/` separators
 *  (e.g. `niche/foo.html`), sorted.
 *
 *  Skips:
 *   - any entry whose name starts with `.` or `_` (hidden / scratch),
 *   - `index.html` at the root (the generated visual overview),
 *   - a TOP-LEVEL `unicode/` subdir (DM-1230). The html suite points its root
 *     at the cloned `external/html-test`, which on CI also contains the
 *     `unicode/` per-block fixtures (818) that the unicode suite targets
 *     directly via `HTML_TEST_DIR=external/html-test/unicode`. Without this skip
 *     the html suite double-covered them (1114 fixtures vs ~295). The skip is
 *     scoped to the root (`prefix === ""`) so when `unicode/` IS the root (the
 *     unicode suite) its own children still walk. */
export function walkHtmlFiles(rootDir: string): string[] {
  const out: string[] = [];
  function visit(dir: string, prefix: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const fullPath = resolve(dir, name);
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      let isDir = false;
      try { isDir = statSync(fullPath).isDirectory(); } catch { continue; }
      if (isDir && prefix === "" && name === "unicode") continue; // separate suite (DM-1230)
      if (isDir) {
        visit(fullPath, relPath);
      } else if (name.endsWith(".html") && relPath !== "index.html") {
        out.push(relPath);
      }
    }
  }
  visit(rootDir, "");
  return out.sort();
}
