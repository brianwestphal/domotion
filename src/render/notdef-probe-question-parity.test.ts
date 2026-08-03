/**
 * The dotted-circle coverage probe and the real per-codepoint resolver must ask
 * the PLATFORM the same question.
 *
 * `codepointResolvesToNotdef` answers "does anything cover `cp`, or does it come
 * out as the primary's `.notdef`?", and `resolveFontForCodepoint` answers "which
 * font paints `cp`?". Different questions of the cascade — but they reach the
 * platform through the SAME call, `resolveSystemFallbackKeyForCp`, and there they
 * must be identical. The probe used to take the run's `lang`, spend it on
 * `fallbackFontChain`, and then drop both it and `systemUiPrimary` on the very
 * next line.
 *
 * Two independent reasons that is a defect, and neither is "it scored badly":
 *
 *  1. The platform can answer "no font at all" for one locale and a covering face
 *     for another, because two of the three backends reject a pick that does not
 *     cover the codepoint — Linux walks fontconfig's sorted set taking only a
 *     covering face, and Windows drops the DirectWrite pick outright
 *     (`!data->FontContainsCharacter(codepoint)` → nullptr,
 *     `platform/fonts/win/font_cache_skia_win.cc:254-256`, Chromium rev
 *     7d859f27). Where the locale steers the matcher, it can therefore flip this
 *     predicate's BOOLEAN, not merely which family answers. On Linux the locale
 *     is the only discriminator there is — Blink hands
 *     `font_description.LocaleOrDefault().Ascii().c_str()` straight to
 *     `GetFontForCharacter` and passes no base font
 *     (`platform/fonts/linux/font_cache_linux.cc:90-95`).
 *  2. `systemFallbackKeyCache` is keyed on both arguments precisely because the
 *     answer is a function of them. An asker that drops them does not share work
 *     with the render path; it populates a PARALLEL set of rows, in an order that
 *     differs from the render path's. Ask order is the exact axis this area has
 *     been bitten on before (an under-keyed cache served whichever spec asked
 *     first).
 *
 * On macOS the locale is genuinely not an input — `GetAlternateFontPlatformData`
 * substitutes from base font + character + size only
 * (`platform/fonts/mac/font_cache_mac.mm:200-212`) — but the BASE is, and it is
 * the run's current font (`:326-327`). `systemUiPrimary` is what separates a
 * `system-ui` run (cascade walked from `CTFontCreateUIFontForLanguage`) from an
 * explicitly-named face landing on the same key, so it has to travel there.
 *
 * Measured before pinning it, so the guard is not mistaken for a fix to a visible
 * bug. macOS host, 1-in-7 stride of U+0020–U+2FFFF x three primaries: supplying
 * `lang` moved the resolved face for 0 of 483,768 asks (as the source predicts)
 * and supplying `systemUiPrimary` moved it for 7,596 of 26,876 `sf-pro` asks,
 * every one to a face that also covers the codepoint — so the boolean did not
 * move for any of 80,628 asks. Linux (Playwright noble image, 1-in-23 stride):
 * `lang` moved the face for up to 2,062 of 8,179 asks per locale, and the boolean
 * again moved 0 times on that inventory. On both, the defect was the question
 * rather than the answer; Windows is where the boolean is expected to move.
 *
 * Source-level rather than behavioral on purpose: the divergence is in which
 * ARGUMENTS reach the platform, and the platform's answer is a property of the
 * host's font inventory, so no assertion about a specific codepoint would hold on
 * all three runners. Comparing the two call sites pins the invariant itself and
 * fails the moment a future argument is wired into one asker and not the other.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codepointResolvesToNotdef, resolveFont, resolveFontKey, stackPrimaryIsSystemUi } from "./font-resolution.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_RESOLUTION_SRC = readFileSync(path.join(HERE, "font-resolution.ts"), "utf-8");
const TEXT_TO_PATH_SRC = readFileSync(path.join(HERE, "text-to-path.ts"), "utf-8");

/** The body of a top-level function, from its `function <name>(` to the next
 *  closing brace in column 0. */
function functionBody(src: string, name: string): string {
  const at = src.search(new RegExp(`^(?:export )?function ${name}\\(`, "m"));
  expect(at, `no top-level function ${name}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", at);
  expect(end, `unterminated function ${name}`).toBeGreaterThan(at);
  return src.slice(at, end);
}

/** The argument list of every `resolveSystemFallbackKeyForCp(...)` CALL (not the
 *  declaration) in `src`, whitespace-normalized, in source order. */
function systemFallbackCallArgs(src: string): string[] {
  const out: string[] = [];
  const marker = "resolveSystemFallbackKeyForCp(";
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
    if (/function\s+$/.test(src.slice(Math.max(0, i - 20), i))) continue; // the declaration
    let depth = 1;
    let j = i + marker.length;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
    }
    // The probe and the resolver spell the primary-key parameter differently;
    // everything else must match literally.
    out.push(src.slice(i + marker.length, j - 1).replace(/\s+/g, " ").trim().replace(/primaryFontKey/g, "primaryKey"));
  }
  return out;
}

/** The coverage probe, the resolver's live-fallback stage, and the test seam
 *  that exists to reproduce their call — the askers that have a run to speak
 *  for. Every other call site is an availability probe with no run context. */
const RUN_CONTEXT_ASKERS = [
  "codepointResolvesToNotdef",
  "resolveFontForCodepointInner",
  "__resolveSystemFallbackKeyForCpForTest",
] as const;

describe("dotted-circle coverage probe asks the platform the resolver's question", () => {
  it("hands the system-fallback resolver the same arguments from every run-context asker", () => {
    const perAsker = RUN_CONTEXT_ASKERS.map((name) => {
      const calls = systemFallbackCallArgs(functionBody(FONT_RESOLUTION_SRC, name));
      expect(calls.length, `${name} must reach the platform exactly once`).toBe(1);
      return calls[0];
    });
    // The load-bearing assertion: identical, argument for argument. The probe
    // used to stop at `primaryKey` while the resolver went on to pass the run's
    // cascade base and locale.
    expect(new Set(perAsker).size, `diverged: ${JSON.stringify(perAsker)}`).toBe(1);
    expect(perAsker[0]).toContain("systemUiPrimary");
    expect(perAsker[0]).toContain("lang");
  });

  it("keeps every run-context asker's argument list ending in systemUiPrimary, lang", () => {
    // Pins the ORDER too: `resolveSystemFallbackKeyForCp` takes
    // (cp, weight, slant, fontSize, primaryKey, systemUiPrimary, lang), and both
    // of the trailing two are optional with defaults — so a transposition is a
    // silently mis-keyed memo rather than a type error wherever the types line up.
    for (const name of RUN_CONTEXT_ASKERS) {
      const args = systemFallbackCallArgs(functionBody(FONT_RESOLUTION_SRC, name))[0];
      expect(args.endsWith("systemUiPrimary, lang"), `${name}: ${args}`).toBe(true);
    }
  });

  it("derives the probe's cascade-base signal from the declared stack, not from the font key", () => {
    // The key cannot carry it: `system-ui` and an explicitly-named "SF Pro Text"
    // resolve to the SAME key while taking different Blink entry points. So the
    // call site must read the stack.
    expect(TEXT_TO_PATH_SRC).toContain("stackPrimaryIsSystemUi(fontFamily))");
    expect(resolveFontKey("system-ui, sans-serif")).toBe(resolveFontKey('"SF Pro Text", sans-serif'));
    expect(stackPrimaryIsSystemUi("system-ui, sans-serif")).toBe(true);
    expect(stackPrimaryIsSystemUi('"SF Pro Text", sans-serif')).toBe(false);
  });

  it("takes the cascade-base signal without disturbing the primary-covered fast path", () => {
    const family = "Helvetica, sans-serif";
    const key = resolveFontKey(family);
    const font = resolveFont(family, 400, 16, 0, undefined);
    if (font == null) return; // host without the family; the parity pins above still hold
    // A covered codepoint returns on the primary's own cmap before the platform
    // is consulted at all, so it is false for every combination on every host.
    for (const systemUi of [false, true]) {
      for (const lang of [undefined, "ja", "zh-CN"]) {
        expect(codepointResolvesToNotdef(0x41, font, key, 400, 16, 0, undefined, lang, systemUi)).toBe(false);
      }
    }
  });

  it.runIf(process.platform === "darwin")("stays locale-invariant on macOS, where Chrome's substitution takes no locale", () => {
    // `GetSubstituteFont(ct_font, character, size)` — base font, character, size,
    // and nothing else (`platform/fonts/mac/font_cache_mac.mm:200-212`). So on
    // darwin the locale must not be able to move this answer, and forwarding it
    // is about the memo key rather than about the result. Measured at 0 moves
    // over 80,628 asks when the argument was first threaded through; this pins
    // that the darwin branch never starts consuming it.
    const family = "Helvetica, sans-serif";
    const key = resolveFontKey(family);
    const font = resolveFont(family, 400, 16, 0, undefined);
    if (font == null) return;
    for (const cp of [0x0f39, 0x1cf4, 0x11a84, 0x16f8f, 0x1e947]) {
      const base = codepointResolvesToNotdef(cp, font, key, 400, 16, 0, undefined, undefined, false);
      for (const lang of ["ja", "zh-CN", "zh-TW", "ko", "hi", "th"]) {
        expect(codepointResolvesToNotdef(cp, font, key, 400, 16, 0, undefined, lang, false)).toBe(base);
      }
    }
  });
});
