/**
 * The dotted-circle coverage probe and the real per-codepoint resolver must
 * agree — and the only way that holds under maintenance is if there is exactly
 * ONE walk.
 *
 * History, because it is the whole design rationale: `codepointResolvesToNotdef`
 * used to be a second, hand-maintained copy of the resolver's walk. It drifted
 * twice in one cycle. First it dropped the platform arguments (`lang` /
 * `systemUiPrimary`) that `resolveFontForCodepoint` passes — the original
 * version of this test pinned the two call sites argument-for-argument. Then,
 * within the hour, a concurrent change threaded `stretch` into the resolver and
 * not the probe, reopening the same asymmetry one parameter further along
 * (which is why the tail assertions below name every expected argument rather
 * than merely comparing lists — a shared omission satisfies equality). And
 * beyond the arguments, the copy never consulted the same SOURCES: it skipped
 * the declared-family walk (`fontKeyChain`, Blink's kFontFamily stage) and all
 * decomposition stages, so it could report "uncovered" (→ synthesize a U+25CC
 * before a mark) for a codepoint the emitter goes on to paint with a real
 * glyph from a later-declared family.
 *
 * The fix is structural: the probe's body IS `!resolveFontForCodepoint(...)
 * .covered`. This file pins that delegation at the source level (so a future
 * "optimization" can't quietly reintroduce a second walk), pins the caller's
 * full argument tail, and pins the discriminating behavior — a mark covered
 * ONLY by a later-declared family reports covered — with the live platform
 * resolver disabled, because on a rich host the platform masks the family
 * walk (measured: 0 boolean moves over 7,582 mark/cluster codepoints x 4
 * system stacks on a dev Mac, live resolver on or off — the skew is a
 * cross-inventory and webfont-stack hazard, invisible to system-stack
 * sampling on one machine).
 *
 * The platform-argument parity pins survive for the askers that still reach
 * `resolveSystemFallbackKeyForCp` directly: the resolver's own live-fallback
 * stage and the test seam that reproduces its call. Why every argument matters
 * (Chromium rev 7d859f27): Linux hands the locale straight to
 * `GetFontForCharacter` with no base font (`platform/fonts/linux/
 * font_cache_linux.cc:90-95`); Windows rejects a pick that does not cover the
 * codepoint (`!data->FontContainsCharacter(codepoint)` → nullptr,
 * `platform/fonts/win/font_cache_skia_win.cc:254-256`), so the locale can flip
 * coverage itself; macOS takes no locale but substitutes from the run's
 * current font (`platform/fonts/mac/font_cache_mac.mm:200-212`, `:326-327`),
 * which is what `systemUiPrimary` distinguishes.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  codepointResolvesToNotdef,
  fallbackFontChain,
  getFontInstance,
  glyphIdForCp,
  registerWebfont,
  clearWebfonts,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  stackPrimaryIsSystemUi,
  withSystemFallbackResolution,
} from "./font-resolution.js";

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

/** Split a function's source into (parameter list, body) at the arrow of its
 *  declaration — crude but sufficient for the top-level shapes pinned here. */
function bodyAfterParams(fnSrc: string): string {
  const open = fnSrc.indexOf("{", fnSrc.indexOf("):"));
  expect(open).toBeGreaterThan(0);
  return fnSrc.slice(open);
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
    // Askers may spell the primary-key parameter differently; everything else
    // must match literally.
    out.push(src.slice(i + marker.length, j - 1).replace(/\s+/g, " ").trim().replace(/primaryFontKey/g, "primaryKey"));
  }
  return out;
}

/** The askers that reach the platform directly and have a run to speak for.
 *  The coverage probe is deliberately NOT here anymore: it delegates to
 *  `resolveFontForCodepoint` and reaches the platform only through it. */
const RUN_CONTEXT_ASKERS = [
  "resolveFontForCodepointInner",
  "__resolveSystemFallbackKeyForCpForTest",
] as const;

describe("dotted-circle coverage probe shares the resolver's walk", () => {
  it("delegates its body to resolveFontForCodepoint with the full argument tail", () => {
    // The load-bearing pin: the probe has NO walk of its own. Its body is the
    // resolver call — full tail, named argument by argument, because the two
    // historical drifts were each a single argument or stage present in one
    // copy and not the other, and comparing shapes (rather than naming the
    // expectation) is satisfied by a shared omission.
    const body = bodyAfterParams(functionBody(FONT_RESOLUTION_SRC, "codepointResolvesToNotdef"))
      .replace(/\s+/g, " ");
    expect(body).toContain(
      "return !resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch).covered;",
    );
  });

  it("keeps the probe free of any residual second copy of the walk", () => {
    // A future edit that reintroduces even one stage inline (a cmap fast path,
    // a chain scan, a direct platform ask) recreates the drift surface this
    // file exists to close. The body may contain the delegation and nothing
    // else that resolves fonts.
    const body = bodyAfterParams(functionBody(FONT_RESOLUTION_SRC, "codepointResolvesToNotdef"));
    for (const banned of [
      "resolveSystemFallbackKeyForCp(",
      "fallbackFontChain(",
      "glyphIdForCp(",
      "getFontInstance(",
      "pickWebfontVariantForCodepoint(",
    ]) {
      expect(body, `probe body must not call ${banned}`).not.toContain(banned);
    }
  });

  it("is called with the run's full context, fontKeyChain included, at its one call site", () => {
    // The caller-side tail, in full — `fontKeyChain` is the argument whose
    // omission this ticket closes (the probe used to see only the primary, so
    // a mark covered by a later-declared family got a spurious circle), and
    // `stackPrimaryIsSystemUi(fontFamily)` / `stretch` are the two that were
    // each dropped once before.
    const call = TEXT_TO_PATH_SRC.replace(/\s+/g, " ");
    expect(call).toContain(
      "codepointResolvesToNotdef(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily), stretch)",
    );
    // And the chain is derived the same way the run splitters derive it.
    expect(TEXT_TO_PATH_SRC).toContain("const fontKeyChain = resolveFontKeyChain(fontFamily);");
  });

  it("hands the system-fallback resolver the same arguments from every remaining run-context asker", () => {
    const perAsker = RUN_CONTEXT_ASKERS.map((name) => {
      const calls = systemFallbackCallArgs(functionBody(FONT_RESOLUTION_SRC, name));
      expect(calls.length, `${name} must reach the platform exactly once`).toBe(1);
      return calls[0];
    });
    expect(new Set(perAsker).size, `diverged: ${JSON.stringify(perAsker)}`).toBe(1);
    expect(perAsker[0]).toContain("systemUiPrimary");
    expect(perAsker[0]).toContain("lang");
    expect(perAsker[0]).toContain("stretch");
  });

  it("keeps every remaining run-context asker's argument list ending in systemUiPrimary, lang, stretch", () => {
    // Pins the ORDER too: `resolveSystemFallbackKeyForCp` takes
    // (cp, weight, slant, fontSize, primaryKey, systemUiPrimary, lang, stretch),
    // and the trailing three are optional with defaults — so a transposition is a
    // silently mis-keyed memo rather than a type error wherever the types line up.
    for (const name of RUN_CONTEXT_ASKERS) {
      const args = systemFallbackCallArgs(functionBody(FONT_RESOLUTION_SRC, name))[0];
      expect(args.endsWith("systemUiPrimary, lang, stretch"), `${name}: ${args}`).toBe(true);
    }
  });

  it("derives the probe's cascade-base signal from the declared stack, not from the font key", () => {
    // The key cannot carry it: `system-ui` and an explicitly-named "SF Pro Text"
    // resolve to the SAME key while taking different Blink entry points. So the
    // call site must read the stack. (The argument used to sit last in these
    // calls; the run's `stretch` now follows it, so the pin matches the call
    // shape rather than a trailing position.)
    expect(TEXT_TO_PATH_SRC).toContain("stackPrimaryIsSystemUi(fontFamily), stretch)");
    expect(stackPrimaryIsSystemUi("system-ui, sans-serif")).toBe(true);
    expect(stackPrimaryIsSystemUi('"SF Pro Text", sans-serif')).toBe(false);
    // The key-collapse itself exists only where the named SF Pro family
    // resolves to the same `sf-pro` key as the generic (macOS with Apple's SF
    // Pro installed). On Linux the keys legitimately diverge — Chrome resolves
    // `system-ui` through fontconfig's raw default while a named "SF Pro Text"
    // falls through the stack (verified on the noble image via
    // getPlatformFontsForNode: WenQuanYi Zen Hei vs Liberation Sans) — so the
    // collapse pin is gated on its own precondition; the source pins above
    // hold everywhere.
    if (resolveFontKey("SF Pro Text") === "sf-pro") {
      expect(resolveFontKey("system-ui, sans-serif")).toBe(resolveFontKey('"SF Pro Text", sans-serif'));
    }
  });

  it("takes the full context without disturbing the primary-covered fast path", () => {
    const family = "Helvetica, sans-serif";
    const key = resolveFontKey(family);
    const font = resolveFont(family, 400, 16, 0, undefined);
    if (font == null) return; // host without the family; the source pins above still hold
    const chain = resolveFontKeyChain(family);
    // A covered codepoint returns on the primary's own cmap before anything
    // else is consulted, so it is false for every combination on every host.
    for (const systemUi of [false, true]) {
      for (const lang of [undefined, "ja", "zh-CN"]) {
        expect(codepointResolvesToNotdef(0x41, font, key, 400, 16, 0, undefined, lang, chain, systemUi)).toBe(false);
      }
    }
  });

  const AUMS_PATH = "/Library/Fonts/Arial Unicode.ttf";
  it.runIf(process.platform === "darwin" && existsSync(AUMS_PATH))(
    "reports covered for a mark only a LATER-declared family carries (the spurious-circle case)",
    () => {
      // U+3099 (combining katakana-hiragana voiced sound mark): Arial Unicode MS
      // covers it; Helvetica does not, and neither does Helvetica's static
      // fallback chain — so with the live platform resolver out of the loop, the
      // declared-family walk is the ONLY thing that can cover it. The old
      // probe (primary + static chain + live resolver, no family walk) answered
      // "uncovered" here and its caller synthesized a U+25CC before a mark the
      // emitter paints normally. Registered as a webfont so the test does not
      // depend on the helper-based installed-font name matcher.
      const MARK = 0x3099;
      try {
        registerWebfont("DM1945 Later Family", 400, "normal", readFileSync(AUMS_PATH));
        const family = 'Helvetica, "DM1945 Later Family"';
        const key = resolveFontKey(family);
        const font = resolveFont(family, 400, 32, 0, undefined);
        expect(font).not.toBeNull();
        const chain = resolveFontKeyChain(family);
        expect(chain).toContain("webfont:dm1945 later family");
        withSystemFallbackResolution(false, () => {
          // Preconditions that make this case DISCRIMINATE (if a future chain
          // recalibration covers U+3099 from a helvetica primary, this stops
          // testing anything — fail loudly so the mark gets re-picked).
          expect(glyphIdForCp(font!, MARK)).toBe(0);
          for (const cand of fallbackFontChain(MARK, key, undefined, { weight: 400, slant: 0, fontSize: 32 })) {
            if (cand === "last-resort") continue;
            const cf = getFontInstance(cand, 400, 32, 0);
            expect(cf == null || glyphIdForCp(cf, MARK) === 0,
              `static chain candidate ${cand} covers U+3099 — pick a new discriminating mark`).toBe(true);
          }
          // The pinned behavior: the later-declared family covers the mark, so
          // the probe must NOT report `.notdef` (no synthetic dotted circle).
          expect(codepointResolvesToNotdef(MARK, font!, key, 400, 32, 0, undefined, undefined, chain)).toBe(false);
          // Control: the same ask WITHOUT the later family in the chain is
          // uncovered — proving the family walk, not some other stage, covers.
          expect(codepointResolvesToNotdef(MARK, font!, key, 400, 32, 0, undefined, undefined, [key])).toBe(true);
        });
      } finally {
        clearWebfonts();
      }
    },
  );
});
