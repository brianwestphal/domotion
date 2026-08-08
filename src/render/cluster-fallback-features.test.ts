// DM-2048 item 4: the shape-then-requeue verdict shape call must carry the
// run's OpenType features, the way Blink's fallback shaping does
// (`ShapeRange(buffer, font_features, …)`,
// `platform/fonts/shaping/harfbuzz_shaper.cc:627-787`, rev 7d859f27). Before
// this fix `shapeVerdicts` always passed `undefined` for the shaper's
// `features` argument (`cluster-fallback.ts:219` at the time the ticket was
// filed) regardless of what the caller supplied — so a `-liga` or
// letter-spacing veto could never influence a cluster's `.notdef` coverage
// verdict, even though such a veto CAN change which glyphs a font's shaper
// maps a cluster to.
//
// `shapeVerdicts` is module-private, so this test observes the wiring at its
// one external seam: `harfbuzzShapeRun`, which `shapeVerdicts` calls directly.
// Wrapping it in a passthrough spy (`vi.fn(actual.harfbuzzShapeRun)`) keeps
// every call's real behavior while recording its arguments — the test fails
// against the unfixed code because the recorded 7th positional argument
// (`features`) would be `undefined` on every call, never the list passed via
// `opts.features`.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

vi.mock("./harfbuzz-shaper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harfbuzz-shaper.js")>();
  return { ...actual, harfbuzzShapeRun: vi.fn(actual.harfbuzzShapeRun) };
});

const MACOS_FONTS = process.platform === "darwin" && fs.existsSync("/System/Library/Fonts/Helvetica.ttc");

(MACOS_FONTS ? describe : describe.skip)("cluster-fallback verdict shaping carries the run's features", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes opts.features into the verdict shape call (not undefined)", async () => {
    const { splitTextIntoFontRunsShaped, _clearClusterVerdictCache } = await import("./cluster-fallback.js");
    const { resolveFont, resolveFontKey, resolveFontKeyChain } = await import("./font-resolution.js");
    const { harfbuzzShapeRun } = await import("./harfbuzz-shaper.js");
    const spy = harfbuzzShapeRun as unknown as ReturnType<typeof vi.fn>;

    const key = resolveFontKey("Helvetica");
    const font = resolveFont("Helvetica", 400, 32, 0);
    expect(font).not.toBeNull();
    const chain = resolveFontKeyChain("Helvetica");

    // Cache is keyed per (face, size, axes, direction, script, lang,
    // features, context) — clear it so the two calls below cannot short
    // circuit through a memoized entry from an earlier test/run.
    _clearClusterVerdictCache();
    spy.mockClear();
    splitTextIntoFontRunsShaped(
      "hello", font!, key, 400, 32, 0, undefined, undefined, chain,
      false, 100, undefined, undefined, undefined, // no opts: features omitted
    );
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(call[6]).toBeUndefined();

    _clearClusterVerdictCache();
    spy.mockClear();
    splitTextIntoFontRunsShaped(
      "hello", font!, key, 400, 32, 0, undefined, undefined, chain,
      false, 100, undefined, undefined, { features: ["-liga"] },
    );
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    // At least one verdict-shape call must have received the feature list —
    // this is the exact line the unfixed code always called with `undefined`.
    expect(spy.mock.calls.some((call) => Array.isArray(call[6]) && (call[6] as string[]).includes("-liga"))).toBe(true);
  });

  it("keys the verdict cache on features — two different feature lists are NOT treated as the same cache entry", async () => {
    const { splitTextIntoFontRunsShaped, _clearClusterVerdictCache } = await import("./cluster-fallback.js");
    const { resolveFont, resolveFontKey, resolveFontKeyChain } = await import("./font-resolution.js");
    const { harfbuzzShapeRun } = await import("./harfbuzz-shaper.js");
    const spy = harfbuzzShapeRun as unknown as ReturnType<typeof vi.fn>;

    const key = resolveFontKey("Helvetica");
    const font = resolveFont("Helvetica", 400, 32, 0);
    const chain = resolveFontKeyChain("Helvetica");

    _clearClusterVerdictCache();
    splitTextIntoFontRunsShaped(
      "hello", font!, key, 400, 32, 0, undefined, undefined, chain,
      false, 100, undefined, undefined, { features: ["-liga"] },
    );
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same text/face/size but a DIFFERENT feature list: had the cache key
    // omitted `features` (the pre-fix shape), this second call would have hit
    // the first call's cached verdict and shaped zero additional times.
    splitTextIntoFontRunsShaped(
      "hello", font!, key, 400, 32, 0, undefined, undefined, chain,
      false, 100, undefined, undefined, { features: ["-clig"] },
    );
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
