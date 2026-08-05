/**
 * Convention guards that pin requirement-level invariants line/branch coverage
 * can't express (DM-1459, modeled on the apple-fm coverage-by-feature exercise):
 *
 *   - Runtime dependency allow-list — a new/stray runtime dep fails here, not in
 *     review (supply-chain + bundle-size discipline).
 *   - No shell-string `exec` — the DM-1332 audit standardized on the argv forms
 *     (`execFile` / `spawn` / `*Sync`), which can't be shell-injected. A new
 *     `exec()` / `execSync()` import fails here.
 *   - Feature-coverage manifest integrity + drift — `tests/feature-coverage.ts`
 *     stays well-formed (unique ids, every asserting-test path exists, no
 *     untested feature) AND in step with the live surface (every public export +
 *     CLI verb/bin is claimed; no stale claim). This is the orthogonal-to-line-
 *     coverage axis, enforced inside `npm test` (the standalone report is
 *     `npm run check:features`). See `docs/83-feature-coverage.md`.
 *
 * The public value-export SURFACE itself is pinned separately in
 * `src/index.exports.test.ts` (DM-1058); the state-transition guard for the
 * process-global render mode is `src/render/render-text-mode-guard.test.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as barrel from "../src/index.js";
import { FEATURES } from "./feature-coverage.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
};

/** All non-test `.ts`/`.tsx` files under `src/`. */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(resolve(ROOT, "src"));
  return out;
}

describe("project conventions", () => {
  it("declares exactly the allow-listed runtime dependencies", () => {
    // Intentional allow-list. Adding a runtime dep is a deliberate call — update
    // this list in the same change so the addition is reviewed, not incidental.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@playwright/test",
      "@xterm/headless",
      "bidi-js",
      "fontkit",
      // No `harfbuzzjs`: the published build is `-DHB_TINY`, which compiles out
      // Apple Advanced Typography, so macOS's `morx`-only system faces shape
      // wrong. `vendor/harfbuzzjs/` is v1.4.0 rebuilt with Chromium's HarfBuzz
      // configuration and imported by relative path instead.
      "kerfjs",
      "sharp",
      "svg2ttf",
      "svgo",
      "wawoff2",
      "zod",
    ]);
  });

  // DM-1980: the font/text subsystem's contract with the rest of the codebase.
  //
  // Measured: the transitive closure from `{text-to-path, font-resolution,
  // text}` is 21 files / ~22.8k lines whose ONLY coupling outward is a single
  // type-only import (`text.ts` -> `capture/types.js`). It is already an island
  // — but nothing said so, and nothing stopped it eroding. `text-to-path.ts`
  // re-exports all ~113 of `font-resolution`'s symbols via `export *`, so any
  // module can reach the whole subsystem through a second door without it being
  // visible in review.
  //
  // This pins the door itself: what the rest of `src/` may import from inside
  // the subsystem. It is a snapshot of today (16 symbols across 6 files), not a
  // design — adding a symbol here is fine and deliberate, which is the point.
  // Most of the list is LIFECYCLE (generation snapshots, document scopes, cache
  // resets) rather than queries; the actual queries are `resolveFontKey`,
  // `getFontInstance` and `renderTextAsPath`.
  //
  // Why this is worth a guard rather than a doc: the subsystem is where ~44% of
  // recent commits land, so it is exactly where an accidental new dependency
  // would appear, and it is the boundary any future extraction would run along.
  it("keeps the font/text subsystem's outward contract to the allow-listed symbols (DM-1980)", () => {
    const FONT_MODULES = new Set([
      "font-resolution", "text-to-path", "text", "glyph-helper", "embedded-font-builder",
      "harfbuzz-shaper", "hb-subset", "unicode-classification", "script-segmentation",
      "font-features", "win-font-fallback", "win32-family-suffix", "embolden-outline",
      "helper-acquire",
    ]);
    const ALLOWED = new Set([
      // lifecycle / scoping
      "beginCharacterFallbackDocument", "endCharacterFallbackDocument",
      "resetGeneration", "snapshotGeneration", "restoreGeneration",
      "glyphDefCount", "getGlyphDefsSince", "truncateGlyphDefs",
      "getEmbeddedFontFaceCss", "withRenderTextMode", "RenderTextMode",
      "registerWebfont", "registerLocalFontAlias",
      // the three real queries
      "resolveFontKey", "getFontInstance", "renderTextAsPath",
    ]);
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      const rel = file.slice(ROOT.length + 1);
      // Files INSIDE the subsystem's own directory are unconstrained.
      if (rel.startsWith("src/render/")) continue;
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(re)) {
        const base = m[2].replace(/\.(js|ts)$/, "").split("/").pop() ?? "";
        if (!FONT_MODULES.has(base)) continue;
        for (const raw of m[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, "");
          if (name !== "" && !ALLOWED.has(name)) offenders.push(`${rel}: ${name}`);
        }
      }
    }
    expect(offenders, "new import out of the font subsystem — add it to ALLOWED deliberately").toEqual([]);
  });

  it("never imports the shell-string `exec` / `execSync` from child_process (DM-1332 — argv forms only)", () => {
    const offenders: string[] = [];
    const re = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
    for (const file of srcFiles()) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(re)) {
        const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        if (names.includes("exec") || names.includes("execSync")) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${names.join(", ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("feature-coverage manifest (DM-1459)", () => {
  const publicExports = Object.keys(barrel as Record<string, unknown>)
    .filter((k) => {
      const v = (barrel as Record<string, unknown>)[k];
      return typeof v === "function" || typeof v === "object";
    })
    .sort();
  const claimedExports = new Set(FEATURES.flatMap((f) => f.exports ?? []));
  const claimedVerbs = new Set(FEATURES.flatMap((f) => f.verbs ?? []));
  const VERBS = ["capture", "animate", "term", "template", "composite"];
  const bins = Object.keys(pkg.bin ?? {});

  it("has unique feature ids", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every feature points at ≥1 asserting test that exists (no gaps, no broken refs)", () => {
    const gaps = FEATURES.filter((f) => f.tests.length === 0).map((f) => f.id);
    const broken = FEATURES.flatMap((f) =>
      f.tests.filter((t) => !existsSync(resolve(ROOT, t))).map((t) => `${f.id} → ${t}`),
    );
    expect({ gaps, broken }).toEqual({ gaps: [], broken: [] });
  });

  it("claims every public value-export (drift: a new export without a feature entry fails)", () => {
    const unclaimed = publicExports.filter((e) => !claimedExports.has(e));
    expect(unclaimed).toEqual([]);
  });

  it("has no stale export claim (an index entry for a removed export fails)", () => {
    const stale = [...claimedExports].filter((e) => !publicExports.includes(e));
    expect(stale).toEqual([]);
  });

  it("claims every CLI verb + published bin", () => {
    const unclaimed = [...VERBS, ...bins].filter((v) => !claimedVerbs.has(v));
    expect(unclaimed).toEqual([]);
  });
});
