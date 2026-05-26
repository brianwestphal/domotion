import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import {
  __helperBinaryForPlatform,
  clearCoretextCache,
  createCoretextFont,
  isCoretextHelperAvailable
} from "./coretext.js";

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
    clearCoretextCache();
  });
  function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    clearCoretextCache();
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
    // Regression for the DM-619d reorg bug: when coretext moved to src/render/
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
    expect(isCoretextHelperAvailable()).toBe(true);
  });

  it("reports unavailable when DOMOTION_HELPER_PATH points at a missing file", () => {
    setEnv("DOMOTION_HELPER_PATH", "/no/such/glyph-helper-binary");
    expect(isCoretextHelperAvailable()).toBe(false);
  });

  it("DOMOTION_DISABLE_HELPER forces unavailable even with a valid override", () => {
    setEnv("DOMOTION_HELPER_PATH", fileURLToPath(import.meta.url));
    setEnv("DOMOTION_DISABLE_HELPER", "1");
    expect(isCoretextHelperAvailable()).toBe(false);
  });
});

// DM-881: end-to-end dispatch through the wrapper on Linux — proves the
// generalized resolution actually spawns the FreeType helper and the
// engine-agnostic `createCoretextFont` wrapper consumes its output. Runs only
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

describeLinux("native helper dispatch on Linux (createCoretextFont)", () => {
  it("extracts an outline from a Linux system font through the wrapper", () => {
    clearCoretextCache();
    expect(isCoretextHelperAvailable()).toBe(true); // resolves the in-tree linux binary

    const fontPath = resolveFontFile([
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/liberation-fonts/LiberationSans-Regular.ttf",
      "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ]);
    if (fontPath == null) return; // no usable font on this runner — skip the body

    const font = createCoretextFont({ fontPath });
    expect(font).not.toBeNull();
    expect(font!.unitsPerEm).toBeGreaterThan(0);

    const H = font!.glyphForCodePoint(0x48); // "H"
    expect(H.id).toBeGreaterThan(0);
    expect(H.advanceWidth).toBeGreaterThan(0);
    expect(H.path.commands.length).toBeGreaterThan(0);
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

  it("returns id=0 / empty path for codepoints the font lacks", () => {
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x6F22 }] }] // Han ideograph in Helvetica
    });
    const result = response.results[0] as { glyphs: GlyphResult[] };
    expect(result.glyphs[0].id).toBe(0);
    expect(result.glyphs[0].d).toBe("");
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
});
