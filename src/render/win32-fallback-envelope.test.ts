/**
 * DM-1889: the per-codepoint system-fallback request envelope, per platform.
 *
 * These exist because the Windows form of this envelope was wrong for a long
 * time and NOTHING caught it — not the unit suite, not the fidelity gates, not
 * the conformance oracle. The oracle in particular reported a stable, plausible
 * Windows number the whole time, because a resolver that answers "no fallback
 * font" for every codepoint does not look broken from the outside; it looks like
 * a platform whose static chain does all the work.
 *
 * The mechanism, in one line: Windows declared a base font that DirectWrite never
 * uses, could not open it (named, no path), and one-shot mode treats an
 * unopenable *declared* font as fatal — so the helper died before running the
 * query, on the only transport Windows had.
 *
 * The asymmetry is therefore load-bearing and must not be "tidied" into
 * uniformity later, which is what the first two tests pin.
 */
import { describe, it, expect } from "vitest";
import { buildFallbackEnvelope } from "./glyph-helper.js";

const REQ = { weight: 400, italic: false, fontSize: 16 };

describe("system-fallback envelope: Windows declares no base font (DM-1889)", () => {
  it("declares NO font on win32", () => {
    // The whole bug. `fonts` must be empty: the win32 helper's fallback handler
    // is not even passed the font map, so any entry here can only fail to open —
    // and a failed open is fatal in one-shot mode.
    const env = buildFallbackEnvelope("Helvetica", [0x4e00], REQ, "win32");
    expect(env.fonts).toEqual([]);
  });

  it("DOES declare a base font on darwin, where the answer depends on it", () => {
    // Not symmetric with the above, and deliberately so: `CTFontCreateForString`
    // resolves from a base face, so dropping it would silently change every macOS
    // answer. A future "simplification" that unifies the two platforms breaks one
    // of them whichever way it goes.
    const env = buildFallbackEnvelope("HelveticaNeue", [0x4e00], REQ, "darwin");
    expect(env.fonts).toHaveLength(1);
    expect(env.fonts[0]).toMatchObject({ ref: "base", postscriptName: "HelveticaNeue", size: 16 });
  });

  it("declares a base font on linux too", () => {
    const env = buildFallbackEnvelope("DejaVuSans", [0x4e00], REQ, "linux");
    expect(env.fonts).toHaveLength(1);
  });

  it("keeps ONE query shape across all three platforms", () => {
    // The query is what carries the actual question; only the `fonts` array
    // differs. Divergence here would mean three platforms asking three different
    // questions, which is what the conformance oracle exists to prevent.
    const forPlatform = (p: NodeJS.Platform) =>
      buildFallbackEnvelope("Helvetica", [0x4e00, 0x0600], REQ, p).queries;
    expect(forPlatform("win32")).toEqual(forPlatform("darwin"));
    expect(forPlatform("linux")).toEqual(forPlatform("darwin"));
    expect(forPlatform("win32")[0]).toMatchObject({
      type: "fallback", fontRef: "base", cps: [0x4e00, 0x0600],
    });
  });

  it("carries the run's real weight and slant into the query, not NORMAL", () => {
    // DM-1864: DirectWrite selects the cut, so asking at weight 400 for a bold
    // run is a different question and returns the regular face. On Windows there
    // is no second in-family re-selection step to recover from that.
    const q = buildFallbackEnvelope("Helvetica", [0x41], { weight: 700, italic: true, fontSize: 16 }, "win32")
      .queries[0] as Record<string, unknown>;
    expect(q.cssWeight).toBe(700);
    expect(q.bold).toBe(true);   // Blink's kBoldThreshold is 600
    expect(q.italic).toBe(true);
  });

  it("treats weight 600 as bold and 599 as not (Blink's kBoldThreshold)", () => {
    const boldOf = (w: number) =>
      (buildFallbackEnvelope("H", [0x41], { weight: w, italic: false, fontSize: 16 }, "win32")
        .queries[0] as Record<string, unknown>).bold;
    expect(boldOf(599)).toBe(false);
    expect(boldOf(600)).toBe(true);
  });

  it("passes the base path through on darwin when one is known", () => {
    const env = buildFallbackEnvelope("X", [0x41], { ...REQ, basePath: "/System/Library/Fonts/X.ttc" }, "darwin");
    expect(env.fonts[0]).toMatchObject({ fontPath: "/System/Library/Fonts/X.ttc" });
  });

  it("builds the system-ui base the way MatchSystemUIFont does (darwin)", () => {
    // DM-1859: the traits are derived helper-side from these CSS numbers, so the
    // envelope carries the numbers rather than pre-computed booleans.
    const env = buildFallbackEnvelope("X", [0x41], { ...REQ, systemUi: true, weight: 700 }, "darwin");
    expect(env.fonts[0]).toMatchObject({ systemUI: true, cssWeight: 700, cssSlant: 0, cssWidth: 100 });
  });

  it("omits the style fields entirely when there is no request to describe", () => {
    // The helpers keep their previous defaults for absent fields, which is how an
    // older Node side stays compatible. Emitting explicit nulls would override
    // those defaults instead of leaving them alone.
    const q = buildFallbackEnvelope("H", [0x41], undefined, "win32").queries[0] as Record<string, unknown>;
    expect("cssWeight" in q).toBe(false);
    expect("bold" in q).toBe(false);
  });
});
