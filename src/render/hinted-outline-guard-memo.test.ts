// The hinted-subset outline guard is asked from a memo, so a face that fails it
// is read from disk once per process rather than once per build.
//
// Measured on `PingFangUI.ttc`, the largest face routed here: 58.3 MB, ~9 ms per
// `readFileSync`, and the guard that consumes those bytes takes 0.02 ms. The OS
// page cache does not make the repeat reads free — the cost is the copy into a
// fresh Buffer, not the I/O — so five builds cost five times as much as one, and
// churn 58 MB each round.
//
// These assert the READ COUNT, not the verdict. A memo that returned the right
// answer while still reading the file would satisfy any assertion about the
// verdict and would fix nothing.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const readFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont, __clearHintedOutlineGuardMemo } =
  await import("./embedded-font-builder.js");

/** Bytes that are not a usable sfnt, so the guard rejects the face — the
 *  PingFang case, minus 58 MB. */
const NOT_AN_SFNT = Buffer.alloc(4096);

/** Track one glyph against a hinted source, then build. */
function buildOnce(path: string, faceIndex: number, key: string): void {
  clearEmbeddedFontBuilder();
  trackGlyphInEmbedFont(key, 1000, 800, -200, 1, [{ command: "moveTo", args: [0, 0] }], 500, {
    italic: false, weight: 400,
    hintedSource: { path, faceIndex, postscriptName: "Test", nameMatched: true, variationAxes: null } as never,
  });
  getBuiltEmbeddedFontFaceCss();
}

const reads = (path: string): number => readFileSync.mock.calls.filter((c) => c[0] === path).length;

beforeEach(() => {
  process.env.DOMOTION_HINTED_SUBSET = "1";
  readFileSync.mockReset();
  readFileSync.mockReturnValue(NOT_AN_SFNT);
  __clearHintedOutlineGuardMemo();
  clearEmbeddedFontBuilder();
});
afterEach(() => {
  delete process.env.DOMOTION_HINTED_SUBSET;
  __clearHintedOutlineGuardMemo();
  clearEmbeddedFontBuilder();
});

describe("the outline guard is asked once per (path, face index)", () => {
  it("reads a rejected face once across repeated builds", () => {
    // The change, stated as the cost it removes.
    const path = "/fake/Rejected.ttc";
    for (let i = 0; i < 5; i++) buildOnce(path, 0, `k${i}`);
    expect(reads(path)).toBe(1);
  });

  it("keeps different members of one collection apart", () => {
    // A `.ttc` member is rejected or accepted individually, so a memo keyed on
    // the path alone would answer for a member it never examined — and would
    // pass the first test while being wrong.
    const path = "/fake/Collection.ttc";
    buildOnce(path, 0, "a");
    buildOnce(path, 7, "b");
    expect(reads(path)).toBe(2);
  });

  it("re-reads after the memo is cleared", () => {
    // The control. Without it, the first test is also satisfied by some other
    // short circuit that skips the read for reasons unrelated to the memo.
    const path = "/fake/Rejected2.ttc";
    buildOnce(path, 0, "c");
    expect(reads(path)).toBe(1);
    __clearHintedOutlineGuardMemo();
    buildOnce(path, 0, "d");
    expect(reads(path)).toBe(2);
  });
});
