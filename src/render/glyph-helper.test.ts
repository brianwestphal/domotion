import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import {
  __helperBinaryForPlatform,
  clearGlyphHelperCache,
  createGlyphHelperFont,
  isGlyphHelperAvailable,
  measureOutlineOffsetY,
  OFFSET_PROBE_GLYPHS,
  resolveSystemFallbackFonts, __helperMetaForTest } from "./glyph-helper.js";

// DM-385 / DM-387: validates the Swift CoreText helper.
// Tests are skipped automatically when:
//   - we're not on macOS (the helper is platform-specific)
//   - the helper binary isn't built yet (developer hasn't run build.sh)
// so this file doesn't break Linux/Windows CI before DM-389/DM-390 land.

const HELPER = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "tools",
  "macos-glyph-extractor",
  "domotion-glyph-paths"
);

const helperAvailable = process.platform === "darwin" && existsSync(HELPER);
const describeHelper = helperAvailable ? describe : describe.skip;

interface GlyphResult {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
}
interface MetaResult {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition?: number;
  underlineThickness?: number;
  strikeoutPosition?: number;
  strikeoutThickness?: number;
}

function callHelper(request: unknown): { results: any[] } {
  const proc = spawnSync(HELPER, [], {
    input: JSON.stringify(request),
    encoding: "utf-8"
  });
  if (proc.status !== 0) {
    throw new Error(`helper exit ${proc.status}: ${proc.stderr}`);
  }
  return JSON.parse(proc.stdout);
}

// DM-881: platform-aware helper resolution. These run on every platform (they
// don't spawn a binary), exercising the resolution + availability gate that
// lets the Linux/Windows helpers be invoked in dev / via DOMOTION_HELPER_PATH,
// not just the macOS one.
describe("platform-aware helper resolution", () => {
  const ENV_KEYS = ["DOMOTION_HELPER_PATH", "DOMOTION_DISABLE_HELPER"] as const;
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearGlyphHelperCache();
  });
  function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    clearGlyphHelperCache();
  }

  it("maps each supported platform to its in-tree extractor binary", () => {
    // Separator-agnostic: path.resolve emits `\` on a Windows host even for the
    // darwin/linux entries, so match either separator.
    expect(__helperBinaryForPlatform("darwin")).toMatch(
      /tools[/\\]macos-glyph-extractor[/\\]domotion-glyph-paths$/
    );
    expect(__helperBinaryForPlatform("linux")).toMatch(
      /tools[/\\]linux-glyph-extractor[/\\]domotion-glyph-paths$/
    );
    expect(__helperBinaryForPlatform("win32")).toMatch(
      /tools[/\\]win32-glyph-extractor[/\\]domotion-glyph-paths\.exe$/
    );
  });

  it("resolves the binary two levels up from the module (repo-root tools/)", () => {
    // Regression for the DM-619d reorg bug: when this module moved to src/render/
    // the relative path still pointed one level up (src/tools/), so the in-tree
    // helper was unreachable. It must resolve to the repo-root tools/ dir.
    const darwinBin = __helperBinaryForPlatform("darwin")!;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url)); // src/render
    const repoRoot = path.resolve(moduleDir, "..", "..");
    expect(darwinBin).toBe(
      path.join(repoRoot, "tools", "macos-glyph-extractor", "domotion-glyph-paths")
    );
  });

  it("returns no binary for a platform without a helper", () => {
    expect(__helperBinaryForPlatform("aix")).toBeUndefined();
    expect(__helperBinaryForPlatform("freebsd")).toBeUndefined();
  });

  it("honors DOMOTION_HELPER_PATH as an override on any platform", () => {
    // Point at a file that definitely exists (this very test module).
    const thisFile = fileURLToPath(import.meta.url);
    setEnv("DOMOTION_HELPER_PATH", thisFile);
    expect(isGlyphHelperAvailable()).toBe(true);
  });

  it("reports unavailable when DOMOTION_HELPER_PATH points at a missing file", () => {
    setEnv("DOMOTION_HELPER_PATH", "/no/such/glyph-helper-binary");
    expect(isGlyphHelperAvailable()).toBe(false);
  });

  it("DOMOTION_DISABLE_HELPER forces unavailable even with a valid override", () => {
    setEnv("DOMOTION_HELPER_PATH", fileURLToPath(import.meta.url));
    setEnv("DOMOTION_DISABLE_HELPER", "1");
    expect(isGlyphHelperAvailable()).toBe(false);
  });
});

// DM-881: end-to-end dispatch through the wrapper on Linux — proves the
// generalized resolution actually spawns the FreeType helper and the
// engine-agnostic `createGlyphHelperFont` wrapper consumes its output. Runs only
// on Linux with the in-tree binary built (skipped elsewhere, so inert on
// macOS/Windows CI). The binary-level FreeType parity is covered separately by
// tests/linux-glyph-extractor.test.ts; this asserts the JS dispatch path.
const LINUX_HELPER = __helperBinaryForPlatform("linux");
const linuxDispatchAvailable =
  process.platform === "linux" && LINUX_HELPER != null && existsSync(LINUX_HELPER);
const describeLinux = linuxDispatchAvailable ? describe : describe.skip;

function resolveFontFile(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

describeLinux("native helper dispatch on Linux (createGlyphHelperFont)", () => {
  it("extracts an outline from a Linux system font through the wrapper", () => {
    clearGlyphHelperCache();
    expect(isGlyphHelperAvailable()).toBe(true); // resolves the in-tree linux binary

    const fontPath = resolveFontFile([
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/liberation-fonts/LiberationSans-Regular.ttf",
      "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ]);
    if (fontPath == null) return; // no usable font on this runner — skip the body

    const font = createGlyphHelperFont({ fontPath });
    expect(font).not.toBeNull();
    expect(font!.unitsPerEm).toBeGreaterThan(0);

    const H = font!.glyphForCodePoint(0x48); // "H"
    expect(H.id).toBeGreaterThan(0);
    expect(H.advanceWidth).toBeGreaterThan(0);
    expect(H.path.commands.length).toBeGreaterThan(0);
  });
});

// DM-1034: the Linux FreeType helper's persistent `--serve` loop — the Linux
// analogue of the macOS test above. Spawn the binary once, stream
// newline-delimited request envelopes on stdin, read one response per line on
// stdout; faces opened once are reused across requests. This is what
// `callHelper` now uses on Linux (the darwin gate was lifted for linux), so we
// exercise the wire protocol directly to guard the FreeType serve loop + face
// reuse, and assert each serve response is BYTE-IDENTICAL to the one-shot
// response for the same envelope (the acceptance contract).
describeLinux("persistent --serve protocol on Linux (DM-1034)", () => {
  it("reuses faces across requests and matches one-shot output byte-for-byte", () => {
    const fontPath = resolveFontFile([
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/liberation-fonts/LiberationSans-Regular.ttf",
      "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ]);
    if (fontPath == null) return; // no usable font on this runner — skip the body

    const FONT = { ref: "f", fontPath, size: 2048 };
    const envA = { fonts: [FONT], queries: [
      { type: "meta", fontRef: "f" },
      { type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x48 }, { cp: 0x65 }, { cp: 0x21 }] }
    ] };
    // Second envelope reuses the SAME font ref to exercise the face cache.
    const envB = { fonts: [FONT], queries: [
      { type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x57 }, { cp: 0x6F }] }
    ] };

    // One-shot reference outputs (raw stdout, trailing newline trimmed).
    const oneShot = (req: unknown): string => {
      const p = spawnSync(LINUX_HELPER!, [], { input: JSON.stringify(req), encoding: "utf-8" });
      expect(p.status).toBe(0);
      return p.stdout.trim();
    };
    const refA = oneShot(envA);
    const refB = oneShot(envB);

    const child = spawn(LINUX_HELPER!, ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
    const inFd = (child.stdin as { fd?: number; _handle?: { fd?: number } }).fd
      ?? (child.stdin as { _handle?: { fd?: number } })._handle?.fd;
    const outFd = (child.stdout as { fd?: number; _handle?: { fd?: number } }).fd
      ?? (child.stdout as { _handle?: { fd?: number } })._handle?.fd;
    expect(inFd).toBeTypeOf("number");
    expect(outFd).toBeTypeOf("number");
    let leftover = "";
    const syncCall = (req: unknown): string => {
      const line = Buffer.from(JSON.stringify(req) + "\n", "utf-8");
      let off = 0;
      while (off < line.length) {
        try { off += writeSync(inFd!, line, off, line.length - off); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; throw e; }
      }
      const tmp = Buffer.allocUnsafe(1 << 20);
      while (!leftover.includes("\n")) {
        try { const n = readSync(outFd!, tmp, 0, tmp.length, null); if (n > 0) leftover += tmp.toString("utf-8", 0, n); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; throw e; }
      }
      const nl = leftover.indexOf("\n");
      const resp = leftover.slice(0, nl);
      leftover = leftover.slice(nl + 1);
      return resp;
    };
    try {
      expect(syncCall(envA)).toBe(refA); // first request opens the face
      expect(syncCall(envB)).toBe(refB); // second reuses the cached face
    } finally {
      child.stdin!.end();
      child.kill();
    }
  });
});

describeHelper("CoreText glyph extractor", () => {
  it("extracts the Helvetica H outline at 100pt", () => {
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 100 }],
      queries: [
        { type: "meta", fontRef: "h" },
        { type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x48 }] }
      ]
    });

    const meta = response.results[0] as MetaResult;
    const glyphResult = response.results[1] as { glyphs: GlyphResult[] };

    expect(meta.unitsPerEm).toBe(2048);
    const H = glyphResult.glyphs[0];
    expect(H.id).toBeGreaterThan(0);
    expect(H.d).toMatch(/^M /);
    expect(H.d).toMatch(/Z$/);
    expect(H.advance).toBeGreaterThan(60);
    expect(H.advance).toBeLessThan(80);
  });

  it("extracts PingFang 漢 (U+6F22) where fontkit can't (DM-382)", () => {
    const response = callHelper({
      fonts: [{ ref: "p", postscriptName: "PingFangSC-Regular", size: 22 }],
      queries: [{ type: "glyphs", fontRef: "p", glyphs: [{ cp: 0x6F22 }] }]
    });
    const result = response.results[0] as { glyphs: GlyphResult[] };
    const han = result.glyphs[0];
    expect(han.id).toBeGreaterThan(0);
    expect(han.d.length).toBeGreaterThan(0);
    expect(han.advance).toBeGreaterThan(0);
  });

  it("agrees with fontkit on Helvetica H advance within 1%", () => {
    const SIZE = 100;
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: SIZE }],
      queries: [
        { type: "meta", fontRef: "h" },
        { type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x48 }] }
      ]
    });
    const meta = response.results[0] as MetaResult;
    const ctH = (response.results[1] as { glyphs: GlyphResult[] }).glyphs[0];

    const collection = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc") as any;
    const helvetica = collection.getFont != null ? collection.getFont("Helvetica") : collection;
    const fkGlyph = helvetica.glyphForCodePoint(0x48);
    const fkAdvancePoints = (fkGlyph.advanceWidth * SIZE) / meta.unitsPerEm;

    expect(Math.abs(ctH.advance - fkAdvancePoints)).toBeLessThan(fkAdvancePoints * 0.01);
  });

  it("returns id=0 (uncovered) for codepoints the font lacks, with the font's .notdef outline (DM-1018)", () => {
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x6F22 }] }] // Han ideograph in Helvetica
    });
    const result = response.results[0] as { glyphs: GlyphResult[] };
    // id 0 is the coverage signal — the codepoint is NOT in the font. Callers
    // gate on this. DM-1018: the helper now ALSO returns glyph 0's outline (the
    // `.notdef` glyph) rather than an empty path, because Blink draws the
    // primary font's `.notdef` for uncovered codepoints (e.g. SF Compact's
    // SignWriting stripes). Helvetica's `.notdef` is a box, so `d` is non-empty.
    expect(result.glyphs[0].id).toBe(0);
    expect(result.glyphs[0].d.length).toBeGreaterThan(0);
  });

  it("notdef query returns the font's glyph-0 outline (DM-1018)", () => {
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 1000 }],
      queries: [{ type: "notdef", fontRef: "h" }]
    });
    const r = response.results[0] as { type: string; id: number; d: string };
    expect(r.type).toBe("notdef");
    expect(r.id).toBe(0);
    expect(r.d.length).toBeGreaterThan(0); // Helvetica .notdef is a visible box
  });

  it("family query resolves a real installed font and rejects unknowns (DM-1018)", () => {
    const resp = callHelper({
      fonts: [],
      queries: [
        { type: "family", name: "Helvetica" },
        { type: "family", name: "ThisFontDoesNotExist98765" },
      ],
    });
    const real = resp.results[0] as { type: string; found: boolean; postscriptName?: string };
    const fake = resp.results[1] as { found: boolean };
    expect(real.found).toBe(true);
    expect(real.postscriptName).toBeTruthy();
    expect(fake.found).toBe(false);
  });

  it("accepts pre-resolved glyph ids in addition to codepoints", () => {
    const probe = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x48 }] }]
    });
    const id = (probe.results[0] as { glyphs: GlyphResult[] }).glyphs[0].id;

    const byId = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ id }] }]
    });
    const byIdGlyph = (byId.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
    expect(byIdGlyph.id).toBe(id);
    expect(byIdGlyph.d.length).toBeGreaterThan(0);
  });

  // DM-1028: the CoreText `shape` query runs CTLine, so an orphaned Brahmic
  // combining mark gets its dotted circle (U+25CC) inserted and both glyphs
  // carry the source cluster + GPOS-decomposed advance/offset. The old naive
  // per-codepoint `layout()` emitted ONE glyph and dropped the dotted circle.
  const javanesePath = "/System/Library/Fonts/Supplemental/NotoSansJavanese-Regular.otf";
  const javaneseInstalled = existsSync(javanesePath);
  const itJavanese = javaneseInstalled ? it : it.skip;

  itJavanese("shape query inserts the dotted circle for an orphaned Javanese vowel sign (U+A9B8)", () => {
    const resp = callHelper({
      fonts: [{ ref: "j", postscriptName: "NotoSansJavanese-Regular", fontPath: javanesePath, size: 1000 }],
      queries: [{ type: "shape", fontRef: "j", text: "\u{A9B8}" }]
    });
    const r = resp.results[0] as { type: string; glyphs?: Array<{ id: number; cluster: number; ax: number; d: string }> };
    expect(r.type).toBe("shape");
    expect(r.glyphs).toBeDefined();
    // The mark shapes to TWO glyphs: an inserted dotted circle + the vowel
    // sign. Both belong to the single source character (cluster 0).
    expect(r.glyphs!.length).toBe(2);
    for (const g of r.glyphs!) {
      expect(g.cluster).toBe(0);
      expect(g.d.length).toBeGreaterThan(0); // both glyphs are inked
    }
  });

  itJavanese("createGlyphHelperFont().layout() returns the shaped cluster with per-glyph clusters", () => {
    clearGlyphHelperCache();
    const font = createGlyphHelperFont({
      postscriptName: "NotoSansJavanese-Regular",
      fontPath: javanesePath
    });
    expect(font).not.toBeNull();
    const laid = font!.layout("\u{A9B8}");
    expect(laid.glyphs.length).toBe(2);
    expect(laid.clusters).toBeDefined();
    expect(laid.clusters).toEqual([0, 0]);
    // Every shaped glyph carries an outline the renderer can emit directly.
    for (const g of laid.glyphs) {
      expect(g.path.commands.length).toBeGreaterThan(0);
    }
    // The cluster's total advance matches Chrome's measured width (the dotted
    // circle advances, the vowel sign overlays it) — non-zero, finite.
    const total = laid.positions.reduce((s, p) => s + p.xAdvance, 0);
    expect(total).toBeGreaterThan(0);
  });

  // DM-1111: a LONE combining mark (no base in its run) must drop CoreText's
  // isolated-mark bearing compensation so it paints at its native side-bearing,
  // matching Chrome/HarfBuzz. CoreText shapes such a mark with a positive
  // xOffset (≈ −leftSideBearing) that cancels the glyph's negative LSB, pushing
  // the ink ~|LSB| px right of where Chrome paints it. The layout wrapper zeroes
  // that xOffset for a run with no advancing base glyph. STIX Two Math's
  // Combining Diacritical Marks for Symbols (U+20D0+) are the canonical case:
  // zero-advance marks whose outline sits entirely LEFT of the origin.
  const stixPath = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf";
  const stixInstalled = existsSync(stixPath);
  const itStix = stixInstalled ? it : it.skip;

  itStix("zeroes CoreText's bearing-comp xOffset for a lone combining mark (DM-1111)", () => {
    clearGlyphHelperCache();
    const font = createGlyphHelperFont({ postscriptName: "STIXTwoMath-Regular", fontPath: stixPath });
    expect(font).not.toBeNull();
    for (const cp of [0x20d0, 0x20d1, 0x20db]) {
      const laid = font!.layout(String.fromCodePoint(cp));
      expect(laid.glyphs.length).toBe(1);
      // Zero advance (combining mark) and NO horizontal offset — the CoreText
      // spacing compensation has been removed.
      expect(laid.positions[0].xAdvance).toBe(0);
      expect(laid.positions[0].xOffset).toBe(0);
      // The native (negative) left side-bearing is preserved in the OUTLINE:
      // the glyph paints left of the origin, exactly as Chrome paints it.
      let minX = Infinity;
      for (const c of laid.glyphs[0].path.commands)
        for (let i = 0; i < c.args.length; i += 2) if (c.args[i] < minX) minX = c.args[i];
      expect(minX).toBeLessThan(0);
    }
  });

  itJavanese("keeps the mark's GPOS offset when an advancing base (CoreText ◌) is present (DM-1111)", () => {
    // The DM-1111 neutralization must NOT touch a mark that's genuinely attached
    // to a base: an orphaned Brahmic mark gets a CoreText-inserted dotted circle
    // (an advancing glyph), so the run HAS a base and the mark's GPOS position is
    // real (Chrome inserts the same ◌). Shaping must still yield the 2-glyph
    // ◌+mark cluster with the base advancing.
    clearGlyphHelperCache();
    const font = createGlyphHelperFont({ postscriptName: "NotoSansJavanese-Regular", fontPath: javanesePath });
    expect(font).not.toBeNull();
    const laid = font!.layout("\u{A9B8}");
    expect(laid.glyphs.length).toBe(2);
    // The inserted dotted circle advances (it's the base); the gate sees an
    // advancing glyph and leaves the cluster's offsets untouched.
    expect(laid.positions.some((p) => p.xAdvance > 0)).toBe(true);
    for (const g of laid.glyphs) expect(g.path.commands.length).toBeGreaterThan(0);
  });

  // DM-1033: `warmGlyphs(cps)` batches the coverage probe for many codepoints
  // into one round-trip, priming the same cache the per-codepoint
  // `glyphForCodePoint` walk reads. It must leave `glyphForCodePoint` returning
  // byte-identical glyphs to the lazy path (it only changes WHEN they're
  // fetched, not WHAT comes back) — the property that lets the renderer pre-warm
  // before `splitTextIntoFontRuns` without altering output.
  it("warmGlyphs primes the cache identically to lazy per-codepoint resolution (DM-1033)", () => {
    const cps = [0x6F22, 0x4E00, 0x4E8C, 0x4E09, 0x65E5, 0x672C]; // 漢 一 二 三 日 本

    // Lazy path: resolve each codepoint on demand.
    const lazy = createGlyphHelperFont({ postscriptName: "PingFangSC-Regular" });
    expect(lazy).not.toBeNull();
    const lazyGlyphs = cps.map((cp) => lazy!.glyphForCodePoint(cp));

    // Pre-warmed path: one batched warm, then the same lookups.
    const warmed = createGlyphHelperFont({ postscriptName: "PingFangSC-Regular" });
    expect(warmed).not.toBeNull();
    warmed!.warmGlyphs(cps);
    const warmGlyphs = cps.map((cp) => warmed!.glyphForCodePoint(cp));

    for (let i = 0; i < cps.length; i++) {
      expect(warmGlyphs[i].id).toBe(lazyGlyphs[i].id);
      expect(warmGlyphs[i].advanceWidth).toBe(lazyGlyphs[i].advanceWidth);
      expect(warmGlyphs[i].path.commands.length).toBe(lazyGlyphs[i].path.commands.length);
      expect(warmGlyphs[i].id).toBeGreaterThan(0); // PingFang covers these
    }

    // A second warm of the now-cached set is a no-op (nothing left to fetch),
    // and re-looking-up still returns the same glyph.
    warmed!.warmGlyphs(cps);
    expect(warmed!.glyphForCodePoint(0x6F22).id).toBe(lazyGlyphs[0].id);
  });

  // DM-1037: `warmShapes(texts)` folds the per-run `shape` round-trips into one
  // batched envelope, priming the same per-run-text shape cache `layout()`
  // reads. Like `warmGlyphs`, it must leave `layout()` returning byte-identical
  // results to the lazy per-run path — it only changes WHEN each run is shaped
  // (once, together) not WHAT comes back. The renderer pre-warms with it after
  // the DM-1036 coverage pre-warm, so coverage is known when `warmShapes` runs;
  // its fully-covered gate mirrors `layout()`'s own shape gate exactly.
  it("warmShapes primes the shape cache identically to lazy per-run layout (DM-1037)", () => {
    // Several distinct CJK runs the same PingFang instance would shape, as a
    // multi-run fallback paragraph produces (each Latin gap splits a new run).
    const runTexts = ["你好", "世界", "早安", "谢谢", "漢字"];

    // Lazy path: each run shaped on demand by its own `layout()` call.
    const lazy = createGlyphHelperFont({ postscriptName: "PingFangSC-Regular" });
    expect(lazy).not.toBeNull();
    const lazyLaid = runTexts.map((t) => lazy!.layout(t));

    // Pre-warmed path: warm coverage (as the DM-1036 pre-warm does), then warm
    // every run's shape in ONE batched envelope, then lay each run out.
    const warmed = createGlyphHelperFont({ postscriptName: "PingFangSC-Regular" });
    expect(warmed).not.toBeNull();
    const allCps = runTexts.flatMap((t) => [...t].map((c) => c.codePointAt(0)!));
    warmed!.warmGlyphs(allCps);
    (warmed as unknown as { warmShapes: (t: string[]) => void }).warmShapes(runTexts);
    const warmLaid = runTexts.map((t) => warmed!.layout(t));

    for (let r = 0; r < runTexts.length; r++) {
      const a = lazyLaid[r];
      const b = warmLaid[r];
      expect(b.glyphs.length).toBe(a.glyphs.length);
      expect(b.glyphs.length).toBeGreaterThan(0);
      expect(b.clusters).toEqual(a.clusters);
      for (let i = 0; i < a.glyphs.length; i++) {
        expect(b.glyphs[i].id).toBe(a.glyphs[i].id);
        expect(b.glyphs[i].advanceWidth).toBe(a.glyphs[i].advanceWidth);
        expect(b.glyphs[i].path.commands.length).toBe(a.glyphs[i].path.commands.length);
        expect(b.positions[i]).toEqual(a.positions[i]);
      }
    }

    // Re-warming the now-cached set is a no-op, and a single-text warm of a
    // brand-new run still primes correctly (matches a fresh lazy shape).
    (warmed as unknown as { warmShapes: (t: string[]) => void }).warmShapes(runTexts);
    const freshText = "你们好"; // 你们好
    const freshLazy = createGlyphHelperFont({ postscriptName: "PingFangSC-Regular" });
    const lazyFresh = freshLazy!.layout(freshText);
    warmed!.warmGlyphs([...freshText].map((c) => c.codePointAt(0)!));
    (warmed as unknown as { warmShapes: (t: string[]) => void }).warmShapes([freshText]);
    const warmFresh = warmed!.layout(freshText);
    expect(warmFresh.glyphs.map((g) => g.id)).toEqual(lazyFresh.glyphs.map((g) => g.id));
  });
});

// How the helper says WHICH face it opened.
//
// `openFont` used to fall back to the container's first descriptor whenever no
// descriptor carried the requested PostScript name, and reported nothing about
// having done so — a caller could not tell "we loaded the face you named" from
// "we loaded member zero and hoped". For a missed `.SFDevanagari-Regular` that
// substitute is `.SFBangla-Ultralight`: Bangla outlines, at ultralight, for
// Devanagari text. Nor can the by-name second chance rescue that class of name —
// CoreText refuses dot-prefixed system names and returns Times New Roman.
//
// So a named request the file cannot answer is now reported unavailable rather
// than substituted, matching what Blink does: `MatchUniqueFont` compares
// CoreText's answer against the request and returns nullptr when they differ
// (font_matcher_mac.mm:451-481, Chromium 7d859f27).
describeHelper("font-resolution reporting", () => {
  const HELVETICA_TTC = "/System/Library/Fonts/Helvetica.ttc";

  function metaFor(spec: Record<string, unknown>) {
    const resp = callHelper({
      fonts: [{ ref: "f", size: 17, ...spec }],
      queries: [{ type: "meta", fontRef: "f" }],
    });
    return resp.results[0] as {
      type: string; error?: string; nameMatched?: boolean;
      resolution?: string; postscriptName?: string;
    };
  }

  it("reports a name matched inside the requested file", () => {
    const m = metaFor({ postscriptName: "Helvetica-Bold", fontPath: HELVETICA_TTC });
    expect(m.error).toBeUndefined();
    expect(m.nameMatched).toBe(true);
    expect(m.resolution).toBe("nameMatchedInFile");
    expect(m.postscriptName).toBe("Helvetica-Bold");
  });

  it("reports the first face as the request when no name was asked for", () => {
    // Not a fallback: nothing was named, so member zero IS what was requested.
    const m = metaFor({ fontPath: HELVETICA_TTC });
    expect(m.nameMatched).toBe(true);
    expect(m.resolution).toBe("firstFaceNoNameRequested");
  });

  it("verifies a by-name rescue when the requested file does not hold the face", () => {
    // The face exists on the system, just not in the file we pointed at.
    const m = metaFor({ postscriptName: "Helvetica", fontPath: "/System/Library/Fonts/Monaco.ttf" });
    expect(m.nameMatched).toBe(true);
    expect(m.resolution).toBe("byNameVerified");
    expect(m.postscriptName).toBe("Helvetica");
  });

  it("flags a name-only resolution it could not verify", () => {
    // CoreText substitutes a default for an unknown name rather than failing.
    // The substitution still happens (a name-only request has nothing else to
    // fall back to), but it is now labeled instead of passing as a match.
    const m = metaFor({ postscriptName: "ThisFontDoesNotExist98765" });
    expect(m.nameMatched).toBe(false);
    expect(m.resolution).toBe("byNameUnverified");
    expect(m.postscriptName).not.toBe("ThisFontDoesNotExist98765");
  });

  it("refuses to substitute the first face for a name absent from the file", () => {
    // The regression this contract exists for. Previously this returned member
    // zero's outlines under a successful-looking response.
    const m = metaFor({ postscriptName: "NoSuchFaceInThisFile", fontPath: HELVETICA_TTC });
    expect(m.error).toBeTruthy();
    expect(m.nameMatched).toBeUndefined();
  });

  it("refuses a dot-prefixed system name absent from the file, which by-name cannot rescue", () => {
    const m = metaFor({ postscriptName: ".SFNoSuchFace-Regular", fontPath: HELVETICA_TTC });
    expect(m.error).toBeTruthy();
  });

  it("does not return the first face's outlines for a name absent from the file", () => {
    // Asserted on OUTLINES, not on the report: the reported metadata is exactly
    // what proved untrustworthy, so the guarantee has to be checked downstream
    // of it. Helvetica's "H" differs from Helvetica-Bold's.
    const bad = callHelper({
      fonts: [{ ref: "f", postscriptName: "NoSuchFaceInThisFile", fontPath: HELVETICA_TTC, size: 100 }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x48 }] }],
    });
    const r = bad.results[0] as { error?: string; glyphs: GlyphResult[] };
    expect(r.error).toBeTruthy();
    expect(r.glyphs).toEqual([]);

    // ...while the member-zero face, asked for by name, still works.
    const good = callHelper({
      fonts: [{ ref: "f", postscriptName: "Helvetica", fontPath: HELVETICA_TTC, size: 100 }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x48 }] }],
    });
    expect((good.results[0] as { glyphs: GlyphResult[] }).glyphs[0].d.length).toBeGreaterThan(0);
  });

  it("keeps distinct faces from one file distinct, and reports each honestly", () => {
    // Guards against a shared-cache collapse: every face here lives in the same
    // container, so a key that ignored the requested name would return one
    // face's outlines for all of them.
    const names = ["Helvetica", "Helvetica-Bold", "Helvetica-Light", "Helvetica-Oblique"];
    const seen = new Map<string, string>();
    for (const postscriptName of names) {
      const resp = callHelper({
        fonts: [{ ref: "f", postscriptName, fontPath: HELVETICA_TTC, size: 100 }],
        queries: [{ type: "meta", fontRef: "f" }, { type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x48 }] }],
      });
      const m = resp.results[0] as { nameMatched: boolean; resolution: string; postscriptName: string };
      expect(m.nameMatched, postscriptName).toBe(true);
      expect(m.resolution, postscriptName).toBe("nameMatchedInFile");
      expect(m.postscriptName, postscriptName).toBe(postscriptName);
      seen.set(postscriptName, (resp.results[1] as { glyphs: GlyphResult[] }).glyphs[0].d);
    }
    expect(new Set(seen.values()).size).toBe(names.length);
  });

  it("does not read a face-wide baseline correction off a substituted font", () => {
    // `createGlyphHelperFont` opens a SECOND, by-NAME handle purely to measure a
    // baseline correction CoreText only reports through the system-registered
    // font. With no file to fall back on, CoreText substitutes Times New Roman
    // for any dot-prefixed Apple system name, so that handle can be a completely
    // different face — and its geometry must not be applied to the real one.
    const m = metaFor({ postscriptName: ".SFDevanagari-Regular" });
    expect(m.nameMatched).toBe(false);
    expect(m.resolution).toBe("byNameUnverified");
    expect(m.postscriptName).toBe("TimesNewRomanPSMT");

    // The by-PATH handle for the same face is unaffected and correct, so the
    // outlines a caller renders from still come from .SF Devanagari.
    const byPath = metaFor({ postscriptName: ".SFDevanagari-Regular", fontPath: "/System/Library/Fonts/SFIndia.ttc" });
    expect(byPath.nameMatched).toBe(true);
    expect(byPath.postscriptName).toBe(".SFDevanagari-Regular");
    // Different faces, so a correction measured on one cannot describe the other.
    expect(byPath.postscriptName).not.toBe(m.postscriptName);
  });

  it("survives an interleaved sequence of failing and succeeding opens in one process", () => {
    // The serve-mode font cache is keyed on the request spec; a throwing open
    // must not poison a later good one for the same file (or vice versa).
    for (let i = 0; i < 2; i++) {
      expect(metaFor({ postscriptName: "NoSuchFaceInThisFile", fontPath: HELVETICA_TTC }).error).toBeTruthy();
      expect(metaFor({ postscriptName: "Helvetica-Bold", fontPath: HELVETICA_TTC }).nameMatched).toBe(true);
      expect(metaFor({ fontPath: HELVETICA_TTC }).resolution).toBe("firstFaceNoNameRequested");
      expect(metaFor({ postscriptName: "Helvetica", fontPath: HELVETICA_TTC }).resolution).toBe("nameMatchedInFile");
    }
  });
});

// DM-1031: the persistent `--serve` protocol. Spawn the binary once, stream
// newline-delimited request envelopes on stdin, read one response per line on
// stdout — fonts are reused across requests so the per-call cost drops from
// ~16 ms (fresh spawn + CoreText init + font open) to a sub-ms round-trip.
// This is what `callHelper` uses by default; here we exercise the wire
// protocol directly to guard the Swift serve loop + font reuse.
describeHelper("persistent --serve protocol (DM-1031)", () => {
  it("handles multiple sequential requests over one long-lived process, reusing fonts", () => {
    const child = spawn(HELPER, ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
    const inFd = (child.stdin as { fd?: number; _handle?: { fd?: number } }).fd
      ?? (child.stdin as { _handle?: { fd?: number } })._handle?.fd;
    const outFd = (child.stdout as { fd?: number; _handle?: { fd?: number } }).fd
      ?? (child.stdout as { _handle?: { fd?: number } })._handle?.fd;
    expect(inFd).toBeTypeOf("number");
    expect(outFd).toBeTypeOf("number");
    let leftover = "";
    const syncCall = (req: unknown): { results: Array<Record<string, unknown>> } => {
      const line = Buffer.from(JSON.stringify(req) + "\n", "utf-8");
      let off = 0;
      while (off < line.length) {
        try { off += writeSync(inFd!, line, off, line.length - off); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; throw e; }
      }
      const tmp = Buffer.allocUnsafe(1 << 20);
      while (!leftover.includes("\n")) {
        try { const n = readSync(outFd!, tmp, 0, tmp.length, null); if (n > 0) leftover += tmp.toString("utf-8", 0, n); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; throw e; }
      }
      const nl = leftover.indexOf("\n");
      const resp = leftover.slice(0, nl);
      leftover = leftover.slice(nl + 1);
      return JSON.parse(resp);
    };
    try {
      const FONT = { ref: "p", postscriptName: "PingFangSC-Regular", fontPath: "/System/Library/Fonts/PingFang.ttc", size: 1000 };
      // First request opens the font + resolves a glyph.
      const r1 = syncCall({ fonts: [FONT], queries: [{ type: "glyphs", fontRef: "p", glyphs: [{ cp: 0x6F22 }] }] });
      const g1 = (r1.results[0] as { glyphs: Array<{ id: number; d: string }> }).glyphs[0];
      expect(g1.id).toBeGreaterThan(0);
      expect(g1.d.length).toBeGreaterThan(0);
      // Second request on the SAME live process reuses the cached font and
      // shapes a string — proves the loop persists and font reuse works.
      const r2 = syncCall({ fonts: [FONT], queries: [{ type: "shape", fontRef: "p", text: "漢字" }] });
      const shaped = (r2.results[0] as { glyphs: unknown[] }).glyphs;
      expect(shaped.length).toBe(2);
    } finally {
      child.stdin!.end();
      child.kill();
    }
  });
});

// DM-1831: CoreText reports Apple Color Emoji's glyphs 100 units (0.125 em at
// its 800 upem) below the outline it hands back for the same glyph, and Chrome
// paints at that bounding rect — so the raw outline needs moving. Every other
// macOS face reports 0. These pin the measurement rule itself; the live-font
// assertion below pins the actual system behavior.
describe("measureOutlineOffsetY (DM-1831)", () => {
  // A unit box from (0,0) to (100,100); `bbox.y` is what CoreText claims.
  const g = (bboxY: number, d = "M 0 0 L 0 100 L 100 100 L 100 0 Z") =>
    ({ id: 1, advance: 100, bbox: { x: 0, y: bboxY, w: 100, h: 100 }, d });

  it("returns 0 when CoreText's rect agrees with the outline", () => {
    expect(measureOutlineOffsetY([g(0), g(0), g(0)], 1000, 1000)).toBe(0);
  });
  it("adopts a unanimous, material offset", () => {
    expect(measureOutlineOffsetY([g(-100), g(-100), g(-100)], 800, 800)).toBe(-100);
  });
  it("scales the probe reading into design units", () => {
    // Probed at 1000 for an 800-upem face: -125 probe units == -100 design units.
    expect(measureOutlineOffsetY([g(-125), g(-125)], 800, 1000)).toBe(-100);
  });
  it("ignores a NON-unanimous reading (per-glyph curve-extrema noise)", () => {
    // PingFang-style scatter: control-point minimum vs tight curve bound.
    expect(measureOutlineOffsetY([g(0), g(-1), g(-1), g(0)], 1000, 1000)).toBe(0);
  });
  it("ignores a unanimous but IMMATERIAL offset (< 1% of the em)", () => {
    expect(measureOutlineOffsetY([g(-1), g(-1)], 1000, 1000)).toBe(0);
  });
  it("ignores blank and malformed probe glyphs rather than reading them as 0", () => {
    const blank = { id: 0, advance: 0, bbox: { x: 0, y: 0, w: 0, h: 0 }, d: "" };
    expect(measureOutlineOffsetY([blank, g(-100), g(-100)], 800, 800)).toBe(-100);
  });
  it("returns 0 when there is nothing to measure", () => {
    expect(measureOutlineOffsetY([], 1000, 1000)).toBe(0);
  });
  it("probes a spread of low glyph ids so blanks still leave samples", () => {
    expect(OFFSET_PROBE_GLYPHS.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...OFFSET_PROBE_GLYPHS)).toBeGreaterThan(0);
  });
});

// Gated on a RESOLVABLE helper (in-tree build or the downloaded release asset),
// not just the in-tree binary, since either can serve these queries.
const darwinHelper = process.platform === "darwin" && isGlyphHelperAvailable();

// DM-1873: a STALE helper is worse than an absent one, and the suites below
// cannot tell you which you have.
//
// Absence is already handled — the gate above skips. But `isGlyphHelperAvailable()`
// answers "is a binary resolvable", not "does it speak the interface this Node
// side expects", and the two diverge in a specific, recurring way: the helper is
// a gitignored build artifact, so a fresh worktree resolves the DOWNLOADED
// RELEASE ASSET, which can predate fields the current Node side reads. When that
// happens the suites do not skip — they run and fail on missing data, and the
// failures present as a *font regression*, the most expensive thing in this
// codebase to chase. It has cost real time three separate times, and once
// produced a wrong "pre-existing on this branch" claim in a ticket note.
//
// `--version` does not help: it reports a binary version that was not bumped when
// `nameMatched` / `resolution` were added to `meta`. So probe the interface
// itself, once, and fail with the remedy rather than with an assertion about a
// glyph.
//
// This is a TEST-only guard on purpose. The runtime degrades correctly on its own
// (`MetaResponse.nameMatched` is optional and only an explicit `false` is treated
// as negative), so a consumer on an older release asset is fine; it is the test
// suite's diagnosis that is misleading, and that is what this fixes.
(darwinHelper ? describe : describe.skip)("helper interface freshness (DM-1873)", () => {
  it("the resolvable helper speaks the meta interface these tests read", () => {
    const meta = __helperMetaForTest("Helvetica");
    expect(meta, "helper resolved but returned no meta for Helvetica").not.toBeNull();
    // `unitsPerEm` proves the query answered at all; the two newer fields are the
    // ones a pre-DM-1015 asset omits.
    expect(meta!.unitsPerEm).toBeGreaterThan(0);
    const stale = meta!.nameMatched === undefined || meta!.resolution === undefined;
    expect(
      stale,
      "STALE HELPER BINARY — it resolved and answered, but its `meta` response is "
      + "missing fields this Node side reads (nameMatched / resolution). This is "
      + "an out-of-date build artifact, NOT a font regression; the suites below will "
      + "fail on missing data if you keep going.\n"
      + "Fix: bash tools/macos-glyph-extractor/build.sh",
    ).toBe(false);
  });
});

(darwinHelper ? describe : describe.skip)("Apple Color Emoji outline offset, live (DM-1831)", () => {
  afterEach(() => clearGlyphHelperCache());

  it("moves the U+20E3 keycap outline down to where Chrome paints it", () => {
    const font = createGlyphHelperFont({
      postscriptName: "AppleColorEmoji",
      fontPath: "/System/Library/Fonts/Apple Color Emoji.ttc"
    });
    if (font == null) return; // face absent on this machine
    const glyph = font.glyphForCodePoint(0x20E3);
    if (glyph.id === 0 || glyph.path.commands.length === 0) return;
    const ys: number[] = [];
    for (const c of glyph.path.commands) for (let i = 1; i < c.args.length; i += 2) ys.push(c.args[i]);
    // Raw glyf outline is 0..708; Chrome paints it at -100..608.
    expect(Math.min(...ys)).toBe(-100);
    expect(Math.max(...ys)).toBe(608);
  });

  it("leaves an ordinary face's outlines untouched", () => {
    const font = createGlyphHelperFont({
      postscriptName: "Helvetica",
      fontPath: "/System/Library/Fonts/Helvetica.ttc"
    });
    if (font == null) return;
    const glyph = font.glyphForCodePoint(0x48); // 'H' sits on the baseline
    if (glyph.id === 0 || glyph.path.commands.length === 0) return;
    const ys: number[] = [];
    for (const c of glyph.path.commands) for (let i = 1; i < c.args.length; i += 2) ys.push(c.args[i]);
    expect(Math.min(...ys)).toBe(0);
  });
});

// The system-fallback answer is not one face per character: CoreText nominates a
// FAMILY member and Blink then re-selects the cut within it at the requested
// traits + weight. Every expectation below is Chrome's own answer, read off
// `CSS.getPlatformFontsForNode` for a `font-family: sans-serif` cell at that CSS
// weight — so a regression here is a regression against the browser, not against
// a table we wrote.
(darwinHelper ? describe : describe.skip)("system-fallback in-family cut re-selection", () => {
  afterEach(() => clearGlyphHelperCache());

  const ask = (cp: number, weight: number, italic = false): string | null =>
    resolveSystemFallbackFonts([cp], "Helvetica", { weight, italic, fontSize: 32 }).get(cp)?.postscriptName ?? null;

  // [codepoint, regular-weight face, [weight, face] …]. The regular-weight face
  // doubles as an availability guard: a machine without that font resolves the
  // codepoint somewhere else entirely, and the case is skipped rather than
  // asserted against a font that isn't there.
  const CASES: Array<[string, number, string, Array<[number, string]>]> = [
    ["Euphemia UCAS (Canadian Aboriginal)", 0x1401, "EuphemiaUCAS", [[100, "EuphemiaUCAS"], [500, "EuphemiaUCAS-Bold"], [900, "EuphemiaUCAS-Bold"]]],
    ["Kefa (Ethiopic)", 0x1200, "KefaIII-Regular", [[100, "KefaIII-Light"], [500, "KefaIII-Bold"], [900, "KefaIII-ExtraBold"]]],
    ["Tamil Sangam MN", 0x0B85, "TamilSangamMN", [[400, "TamilSangamMN"], [500, "TamilSangamMN-Bold"]]],
    ["Mukta Mahee (Gurmukhi)", 0x0A05, "MuktaMahee-Regular", [[300, "MuktaMahee-Light"], [700, "MuktaMahee-Bold"]]],
    ["Noto Sans Myanmar", 0x1000, "NotoSansMyanmar-Regular", [[200, "NotoSansMyanmar-Thin"], [900, "NotoSansMyanmar-Black"]]],
  ];

  for (const [label, cp, regular, expectations] of CASES) {
    it(`${label}: takes the cut Chrome takes at each weight`, () => {
      if (ask(cp, 400) !== regular) return; // family not installed on this host
      for (const [weight, want] of expectations) {
        expect(ask(cp, weight), `weight ${weight}`).toBe(want);
      }
    });
  }

  it("memoizes per CSS description, not per codepoint", () => {
    if (ask(0x1401, 400) !== "EuphemiaUCAS") return;
    // Asking at 400 first must not pin the 700 answer to the 400 answer.
    expect(ask(0x1401, 700)).toBe("EuphemiaUCAS-Bold");
    expect(ask(0x1401, 400)).toBe("EuphemiaUCAS");
  });

  it("keeps the nominated face when no CSS description is supplied", () => {
    const nominated = resolveSystemFallbackFonts([0x1401]).get(0x1401)?.postscriptName ?? null;
    if (nominated == null) return;
    expect(nominated).toBe("EuphemiaUCAS");
  });
});
