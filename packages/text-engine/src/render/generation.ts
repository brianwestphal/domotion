/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { createHash } from "node:crypto";
import { clearGlyphHelperCodepointMemos, clearGlyphHelperCache } from "./glyph-helper.js";
import { clearHbFontCache, clearTrakStatCache } from "./harfbuzz-shaper.js";
import {
  clearEmbeddedFontBuilder,
  getBuiltEmbeddedFontFaceCss,
  restoreEmbeddedFonts,
  snapshotEmbeddedFonts,
} from "./embedded-font-builder.js";
import type { EmbeddedFontSnapshot } from "./embedded-font-builder.js";
import { clearIcuHelper } from "./icu-helper.js";
import { fontInstanceCache } from "./font-instance.js";
import { resolvedSpecCache } from "./font-paths.win32.js";
import { fcMatchCache } from "./font-paths.win32.js";
import { systemFallbackKeyCache } from "./font-spec.js";
import { fallbackFamilyCutCache } from "./system-fallback-resolver.js";
import { fallbackBaseCache } from "./system-fallback-resolver.js";
import { darwinPrimaryCutCache } from "./family-match.js";
import { linuxPrimaryCutCache } from "./family-match.js";
import { win32PrimaryCutCache } from "./fallback-chain.linux.js";
import { helperFontCache } from "./font-instance.js";
import { helperOutlineCache } from "./font-instance.js";
import { fileFaceInfoCache } from "./font-instance.js";
import { _famAvailCache } from "./font-instance.js";
import { win32FamilyKeyCache } from "./fallback-chain.linux.js";
import { darwinHandleAxesMap } from "./font-instance.js";
import { _sysfbCoverage } from "./system-fallback-resolver.js";
import { coverageBitsets } from "./font-instance.js";
import { dynamicSystemFontPaths } from "./font-paths.win32.js";
import { _charFallbackDocCache } from "./system-fallback-resolver.js";
import { resetCharacterFallbackRendererCaches } from "./system-fallback-resolver.js";
import { declaredFamilyForKey } from "./family-match.js";
import { win32SuffixDeclaredForKey } from "./fallback-chain.linux.js";
import { localFontAliasRegistry } from "./webfont-registry.js";
import { setDarwinSystemUiPlatformCacheWarm } from "./font-instance.js";

/**
 * Reset the embedded-font subset builder (the per-generation `@font-face`
 * registry and its `dmfN` family counter).
 */
export function clearEmbeddedFonts(): void {
  clearEmbeddedFontBuilder();
}

/**
 * Reset ALL generation-scoped render caches together — the embedded-font subset
 * builder (`clearEmbeddedFonts`) AND the paths-mode glyph-defs registry
 * (`clearGlyphDefs`). Every multi-pass producer (capture, scroll composer)
 * starts a fresh generation by clearing both; calling them piecemeal is the
 * footgun that caused the DM-1338 stale-glyph-defs bug, so this bundles them so
 * a caller can't clear a partial set. Does NOT touch the webfont registry
 * (`clearWebfonts`) — that's session-scoped (user-registered fonts persist
 * across generations). DM-1435.
 */
export function resetGeneration(): void {
  clearEmbeddedFonts();
  clearGlyphDefs();
}

/**
 * Emit one `@font-face` rule per font the embedded-font path registered
 * during this render pass. Returns the CSS to inject into the SVG's
 * `<style>` block (or `<defs><style>`). Empty string when no fonts were
 * registered (e.g. `renderText: "paths"`).
 */
export function getEmbeddedFontFaceCss(): string {
  // Every embedded font goes through the custom-TTF subset builder.
  return getBuiltEmbeddedFontFaceCss();
}

// ── Glyph Registry (for <defs>/<use> deduplication) ──

/** Stores unique glyph path definitions. Uses short sequential IDs for compact output. */
const glyphDefs = new Map<string, string>();

const glyphKeyToId = new Map<string, string>();

let glyphIdCounter = 0;

export function ensureGlyphDef(
  fontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  glyphId: number,
  commands: Array<{ command: string; args: number[] }>,
  /** CSS `font-stretch` percentage. Part of the def identity because the SAME
   *  (fontKey, weight, size, slant, glyphId) tuple names DIFFERENT outlines at
   *  different widths: the run splitter keys runs by the BASE font key while
   *  the width decision (condensed cut, or the system-ui `wdth` axis) happens
   *  inside `getFontInstance` — so without this slot a normal-width run reused
   *  the condensed run's registered outlines glyph id for glyph id. */
  stretch: number = 100,
): string {
  // The same CSS tuple/gid can name different variable-axis outlines (custom
  // GRAD and opsz mutations are the concrete discriminator). Bind the cache to
  // the actual commands so a warm render cannot reuse a prior instance's path.
  const outlineSha256 = createHash("sha256").update(JSON.stringify(commands)).digest("hex");
  const key = `${fontKey}-${weight}-${fontSize}-${slant}${stretch !== 100 ? `-w${stretch}` : ""}-${glyphId}-${outlineSha256}`;
  const existing = glyphKeyToId.get(key);
  if (existing != null) return existing;

  // Short sequential ID for compact output
  const defId = `g${glyphIdCounter++}`;
  glyphKeyToId.set(key, defId);

  // Convert glyph commands to SVG path data at font-unit scale.
  // Use integer coordinates (font units are integers) and shorthand commands.
  let d = "";
  let prevX = 0,
    prevY = 0;
  for (const cmd of commands) {
    const a = cmd.args;
    switch (cmd.command) {
      case "moveTo":
        d += `M${a[0]} ${a[1]}`;
        prevX = a[0];
        prevY = a[1];
        break;
      case "lineTo":
        if (a[1] === prevY) {
          d += `H${a[0]}`;
        } else if (a[0] === prevX) {
          d += `V${a[1]}`;
        } else {
          d += `L${a[0]} ${a[1]}`;
        }
        prevX = a[0];
        prevY = a[1];
        break;
      case "quadraticCurveTo":
        d += `Q${a[0]} ${a[1]} ${a[2]} ${a[3]}`;
        prevX = a[2];
        prevY = a[3];
        break;
      case "bezierCurveTo":
        d += `C${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]}`;
        prevX = a[4];
        prevY = a[5];
        break;
      case "closePath":
        d += "Z";
        break;
    }
  }

  glyphDefs.set(defId, `<path id="${defId}" d="${d}"/>`);
  return defId;
}

/**
 * Get all glyph <defs> accumulated so far. Call this once when building the final SVG.
 * Returns SVG markup to place inside a <defs> block.
 */
export function getGlyphDefs(): string {
  return [...glyphDefs.values()].join("");
}

/**
 * Count of glyph defs registered so far. Paired with `getGlyphDefsSince` to emit
 * ONLY the glyphs a bounded region of a render produced. The animator's typing
 * overlay (DM-1557) renders glyph paths late — after the frames it's layered
 * onto were already rendered — and must splice just its own glyph defs into the
 * top-level `<defs>` without re-emitting (and thus duplicating the ids of) the
 * frames' glyphs. Snapshot the count before rendering the overlay, then emit
 * `getGlyphDefsSince(snapshot)`.
 */
export function glyphDefCount(): number {
  return glyphDefs.size;
}

/**
 * SVG `<path>` defs registered AFTER the `startCount`-th (i.e. those with
 * insertion index ≥ `startCount`). The registry is append-only between
 * `clearGlyphDefs()` calls and ids are assigned sequentially, so slicing the
 * insertion-ordered values by count returns exactly the newly-added defs. See
 * `glyphDefCount`.
 */
export function getGlyphDefsSince(startCount: number): string {
  return [...glyphDefs.values()].slice(startCount).join("");
}

/**
 * Drop every process-global font-resolution MEMO, freeing the fontkit `Font`
 * objects they retain.
 *
 * For long-running sweeps over a large codepoint space — the conformance oracle
 * is the motivating caller — these memos are unbounded in the size of that
 * space, and the retention is far larger than the entry count suggests: fontkit
 * memoizes a `Glyph` object per glyph id for the life of a `Font`, so a `Font`
 * held by `fontInstanceCache` accumulates one retained `Glyph` for every
 * codepoint ever probed through it. A full-universe sweep exhausted a default
 * Node heap partway through, which made the instrument report a PREFIX of the
 * universe as though it were the whole answer.
 *
 * Clearing is safe because every entry here is a pure function of its key:
 * a cold lookup re-derives the identical answer, it just pays for the
 * file/CoreText read again. It is NOT free — expect a sweep to slow measurably —
 * so this is for bounded-memory batch work, not per-render use.
 *
 * Deliberately NOT cleared, because they are registries rather than memos and
 * dropping them would change behavior, not just cost:
 *
 *  - `webfontRegistry` / `localFontAliasRegistry` — caller-
 *    supplied state (see `clearWebfonts` / `clearEmbeddedFonts` to drop those
 *    deliberately).
 *  - `dynamicSystemFontPaths` — on-disk faces the system fallback discovered
 *    that the static tables don't list. `resolveFontSpec` consults it, so a
 *    cleared entry would make a previously-resolvable `sysfb:` key stop
 *    resolving. It is bounded by the number of distinct fonts, not by
 *    codepoints, so it is not part of the growth being addressed here.
 */
export function clearFontResolutionCaches(): void {
  fontInstanceCache.clear();
  resolvedSpecCache.clear();
  fcMatchCache.clear();
  systemFallbackKeyCache.clear();
  fallbackFamilyCutCache.clear();
  fallbackBaseCache.clear();
  darwinPrimaryCutCache.clear();
  linuxPrimaryCutCache.clear();
  win32PrimaryCutCache.clear();
  helperFontCache.clear();
  helperOutlineCache.clear();
  fileFaceInfoCache.clear();
  _famAvailCache.clear();
  win32FamilyKeyCache.clear();
  darwinHandleAxesMap.clear();
  // `systemFallbackKeyCache` above is this module's per-codepoint memo; the
  // answers it memoizes come from `glyph-helper.ts`, which keeps its OWN
  // per-codepoint memo one layer down. Trimming only the upper one bounded the
  // cheap half of the growth and left the expensive half — a full-corpus sweep
  // still exhausted the heap, because the helper memo had no caller outside the
  // unit tests. The two are the same class of state and must be dropped
  // together.
  _sysfbCoverage.clear();
  // 136 KB per physical face, and the key set grows with every face the
  // resolver reaches — a full-corpus sweep touches hundreds, so this is the
  // same unbounded-growth shape as the memos above rather than a fixed cost.
  // Rebuilding one is a single fontkit open, which is what this whole entry
  // point trades memory for.
  coverageBitsets.clear();
  // Same class as `helperFontCache` above: one retained HarfBuzz face per font file.
  clearHbFontCache();
  clearGlyphHelperCodepointMemos();
}

const fontEnvironmentInvalidators = new Set<() => void>();

/** Register a cache owned by a higher renderer layer for host-environment invalidation. */
export function registerFontEnvironmentInvalidator(invalidate: () => void): () => void {
  fontEnvironmentInvalidators.add(invalidate);
  return () => fontEnvironmentInvalidators.delete(invalidate);
}

/**
 * Invalidate answers derived from the host font environment.
 *
 * This is the Domotion analogue of Blink `FontCache::Invalidate()`: use it
 * after an installed-font/fontconfig/preferences generation change. Unlike
 * `clearFontResolutionCaches()`, which is a correctness-neutral memory trim,
 * this also drops native-helper availability, installed-family/style/trait,
 * and platform-fallback answers so the next lookup observes the new host.
 * Downloaded webfont buffers remain intact. `local()` aliases are discarded:
 * their selected installed face is itself an environment-derived answer and
 * must be rediscovered by the capture session after invalidation.
 */
export function invalidateFontEnvironmentCaches(): void {
  clearFontResolutionCaches();
  clearGlyphHelperCache();
  clearHbFontCache();
  clearTrakStatCache();
  clearIcuHelper();
  dynamicSystemFontPaths.clear();
  // The document-scoped ideograph cache stores `sysfb:` keys that resolve only
  // through the registry cleared above; a surviving entry would name a face
  // that no longer opens. Blink's Invalidate drops its fallback caches with the
  // platform-data cache for the same reason. The open scope (if any) is emptied
  // in place; session-owned maps are replaced so the next begin starts fresh.
  _charFallbackDocCache?.clear();
  resetCharacterFallbackRendererCaches();
  declaredFamilyForKey.clear();
  win32SuffixDeclaredForKey.clear();
  localFontAliasRegistry.clear();
  setDarwinSystemUiPlatformCacheWarm(false);
  for (const invalidate of fontEnvironmentInvalidators) invalidate();
}

/** Test-only sizes for the three platform primary-cut memos. */
export function __primaryCutCacheSizesForTest(): {
  darwin: number;
  linux: number;
  win32: number;
} {
  return {
    darwin: darwinPrimaryCutCache.size,
    linux: linuxPrimaryCutCache.size,
    win32: win32PrimaryCutCache.size,
  };
}

/** Test-only: populate all platform cut memos without requiring three hosts. */
export function __seedPrimaryCutCachesForTest(): void {
  darwinPrimaryCutCache.set("test", null);
  linuxPrimaryCutCache.set("test", null);
  win32PrimaryCutCache.set("test", null);
}

/**
 * Clear the `paths`-mode glyph registry. Producers call this once per top-level
 * generation, alongside `clearEmbeddedFonts()` (DM-1338), so the module-global
 * `<path id="gN">` defs don't accumulate across back-to-back renders. No-op in
 * the default `embedded-font` mode, where the registry is never populated.
 */
export function clearGlyphDefs(): void {
  glyphDefs.clear();
  glyphKeyToId.clear();
  glyphIdCounter = 0;
}

/**
 * Roll the registry back to a `glyphDefCount()` snapshot — dropping every def
 * registered after it and resetting the id counter. A producer that emits a
 * BOUNDED region's glyph defs and wants to leave the registry exactly as it
 * found it uses this (DM-1557: the animator emits its typing-overlay glyphs into
 * the top-level `<defs>`, then restores, so a second `generateAnimatedSvg` call
 * in the same process re-assigns the SAME ids — byte-stable output — instead of
 * drifting the global counter). No-op when `count` is at or past the current
 * count.
 */
export function truncateGlyphDefs(count: number): void {
  if (glyphIdCounter <= count) return;
  for (let i = count; i < glyphIdCounter; i++) glyphDefs.delete(`g${i}`);
  for (const [k, v] of glyphKeyToId) {
    if (parseInt(v.slice(1), 10) >= count) glyphKeyToId.delete(k);
  }
  glyphIdCounter = count;
}

/**
 * Opaque rollback marker for the paths-mode glyph registry — the full state,
 * not just a count. `truncateGlyphDefs` is the cheap cursor form and is enough
 * for the animator's append-only overlay; a SPECULATIVE pass may also clear the
 * registry outright (any nested producer that starts its own generation calls
 * `resetGeneration()`), which a count can't undo. This marker survives that.
 */
export interface GlyphDefsSnapshot {
  readonly defs: ReadonlyArray<readonly [string, string]>;
  readonly keyToId: ReadonlyArray<readonly [string, string]>;
  readonly idCounter: number;
}

/** Capture the paths-mode glyph registry as a rollback marker. */
export function snapshotGlyphDefs(): GlyphDefsSnapshot {
  return { defs: [...glyphDefs], keyToId: [...glyphKeyToId], idCounter: glyphIdCounter };
}

/** Roll the paths-mode glyph registry back to a `snapshotGlyphDefs()` marker.
 *  Reusable: the marker holds values, so restoring it twice is well-defined. */
export function restoreGlyphDefs(snapshot: GlyphDefsSnapshot): void {
  glyphDefs.clear();
  for (const [id, markup] of snapshot.defs) glyphDefs.set(id, markup);
  glyphKeyToId.clear();
  for (const [key, id] of snapshot.keyToId) glyphKeyToId.set(key, id);
  glyphIdCounter = snapshot.idCounter;
}

/**
 * Rollback marker for BOTH generation-scoped render registries — the
 * embedded-font subset builder and the paths-mode glyph-defs registry. Opaque:
 * hand it back to `restoreGeneration()`.
 */
export interface GenerationSnapshot {
  readonly fonts: EmbeddedFontSnapshot;
  readonly glyphDefs: GlyphDefsSnapshot;
}

/**
 * Capture BOTH generation-scoped registries so a speculative render can be
 * rolled back wholesale — the transactional sibling of `resetGeneration()`.
 *
 * The use case is composing a variant just to measure its real byte size, then
 * discarding it: without a rollback the trial permanently shifts the `dmfN`
 * family names and PUA codepoints (embedded-font mode) or the `gN` def ids
 * (paths mode) that the REAL output goes on to use, so the output stops being a
 * function of its input. Snapshot, compose the trial, measure, restore, compose
 * for real — the bytes are then identical to the no-trial run.
 *
 * Bundled for the same reason `resetGeneration()` is: which registry is live
 * depends on the process-global render-text mode, so a caller that snapshots
 * only one is correct until someone flips the mode. Does NOT cover the webfont
 * registry (session-scoped, and only capture mutates it) or the font-instance /
 * outline caches (memoized deterministic lookups — they never affect output
 * bytes).
 */
export function snapshotGeneration(): GenerationSnapshot {
  return { fonts: snapshotEmbeddedFonts(), glyphDefs: snapshotGlyphDefs() };
}

/**
 * Roll both generation-scoped registries back to a `snapshotGeneration()`
 * marker. Never throws (an empty marker just empties them); markers are
 * reusable and nest, so `snapshot → snapshot → restore → restore` unwinds
 * correctly.
 *
 * Contract: whatever the speculative pass emitted must be discarded — it holds
 * ids that are handed back out to the next composition.
 */
export function restoreGeneration(snapshot: GenerationSnapshot): void {
  restoreEmbeddedFonts(snapshot.fonts);
  restoreGlyphDefs(snapshot.glyphDefs);
}
