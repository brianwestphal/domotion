/**
 * DM-1874: the per-side fingerprint that lets a baseline diff say WHICH image
 * moved.
 *
 * The tolerance is the whole design, so it is what these test. A digest that is
 * too strict reports "changed" on every CI run (raster is not bit-stable — the
 * same commit differed by 280 px of antialiasing between two runs) and
 * classifies nothing; one that is too loose misses a genuinely different face,
 * which is the event worth catching.
 */
import { describe, it, expect } from "vitest";
import { attributeMovement, attributeMovementWithBytes, compareDigest, compareSideEvidence, perceptualDigest } from "./side-digest.js";

/** RGBA buffer of `w`×`h`, filled by a per-pixel callback returning grey 0..255. */
function img(w: number, h: number, f: (x: number, y: number) => number): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y), i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  return d;
}

describe("perceptual side digest (DM-1874)", () => {
  it("is stable for identical input", () => {
    const a = img(64, 64, (x, y) => (x + y) % 256);
    expect(perceptualDigest(a, 64, 64)).toBe(perceptualDigest(a, 64, 64));
  });

  it("ABSORBS antialiasing-scale noise — the property the whole design rests on", () => {
    // A few pixels nudged by a small amount, scattered. This is what CI raster
    // does run-to-run, and a content hash would call it a change every time.
    const base = img(64, 64, () => 200);
    const jittered = img(64, 64, (x, y) => ((x * 7 + y * 13) % 97 === 0 ? 196 : 200));
    expect(perceptualDigest(jittered, 64, 64)).toBe(perceptualDigest(base, 64, 64));
  });

  it("DETECTS a whole-cell change — the event worth catching", () => {
    // One 16th of the image going dark is the scale of a glyph swapped for a
    // differently-shaped one, which is what an oracle-side move looks like.
    const base = img(64, 64, () => 200);
    const changed = img(64, 64, (x, y) => (x < 16 && y < 16 ? 20 : 200));
    expect(perceptualDigest(changed, 64, 64)).not.toBe(perceptualDigest(base, 64, 64));
  });

  it("is comparable across differing image sizes", () => {
    // Fixed 16×16 grid, not a fixed cell size — so a resized fixture does not
    // read as a content change in every cell.
    const small = perceptualDigest(img(32, 32, (x) => (x < 16 ? 0 : 255)), 32, 32);
    const large = perceptualDigest(img(128, 128, (x) => (x < 64 ? 0 : 255)), 128, 128);
    expect(small).toBe(large);
  });

  it("composites alpha against white, so transparent and white agree", () => {
    // Text fixtures are mostly transparent-or-white background; treating those
    // as different would flag a change with no visual difference.
    const white = img(32, 32, () => 255);
    const transparent = new Uint8Array(32 * 32 * 4); // all zero → alpha 0
    expect(perceptualDigest(transparent, 32, 32)).toBe(perceptualDigest(white, 32, 32));
  });

  it("returns a fixed-length lower-case hex string", () => {
    const d = perceptualDigest(img(8, 8, () => 128), 8, 8);
    expect(d).toHaveLength(256);          // 16×16 cells, one nibble each
    expect(d).toMatch(/^[0-9a-f]+$/);
  });

  it("returns empty for degenerate input rather than throwing", () => {
    // Empty compares unequal to everything, which degrades to "cannot
    // attribute" — the safe direction. A false "unchanged" would be worse.
    expect(perceptualDigest(new Uint8Array(0), 0, 0)).toBe("");
    expect(perceptualDigest(new Uint8Array(4), 10, 10)).toBe("");
  });
});

describe("movement attribution (DM-1874)", () => {
  it("names the ORACLE when only expected moved", () => {
    // The case that cost a bisect: Chrome painted a different face, our output
    // was byte-identical.
    expect(attributeMovement("aaa", "bbb", "ccc", "ccc")).toBe("oracle");
  });

  it("names the RENDERER when only actual moved", () => {
    expect(attributeMovement("aaa", "aaa", "ccc", "ddd")).toBe("renderer");
  });

  it("says both when both moved", () => {
    expect(attributeMovement("aaa", "bbb", "ccc", "ddd")).toBe("both");
  });

  it("flags NEITHER when the metric moved but no image did", () => {
    // Not a nothing-case: it means the metric is not a function of the two
    // images — a comparator change, or a digest too coarse to see this one.
    expect(attributeMovement("aaa", "aaa", "ccc", "ccc")).toBe("neither");
  });

  it("returns unknown when any digest is missing, rather than guessing", () => {
    // An older baseline predates the field. Guessing would manufacture exactly
    // the false confidence this feature exists to remove.
    expect(attributeMovement(undefined, "bbb", "ccc", "ccc")).toBe("unknown");
    expect(attributeMovement("aaa", "bbb", undefined, "ccc")).toBe("unknown");
    expect(attributeMovement("", "bbb", "ccc", "ccc")).toBe("unknown");
  });

  it("compareDigest treats absent and empty alike", () => {
    expect(compareDigest("a", "a")).toBe("same");
    expect(compareDigest("a", "b")).toBe("moved");
    expect(compareDigest(undefined, "a")).toBe("unknown");
    expect(compareDigest("", "")).toBe("unknown");
  });
});

describe("byte-aware side evidence (DM-1937)", () => {
  it("equal shas are proof of identity, regardless of digests", () => {
    expect(compareSideEvidence("aaa", "aaa", "s1", "s1")).toBe("byte-identical");
    // Even with digests missing — bytes equal implies digests equal.
    expect(compareSideEvidence(undefined, undefined, "s1", "s1")).toBe("byte-identical");
  });

  it("equal digests with DIFFERING bytes are sub-digest, never 'same'", () => {
    // The trap this ticket exists for: two distinct PNGs (2,900 bytes apart)
    // hashed to identical perceptual digests, and an A/B read that as inert.
    expect(compareSideEvidence("aaa", "aaa", "s1", "s2")).toBe("sub-digest");
  });

  it("equal digests without byte hashes keep the legacy 'not detected' reading", () => {
    expect(compareSideEvidence("aaa", "aaa")).toBe("same-at-digest");
  });

  it("a moved digest is moved, whatever the bytes say", () => {
    expect(compareSideEvidence("aaa", "bbb", "s1", "s2")).toBe("moved");
    expect(compareSideEvidence("aaa", "bbb")).toBe("moved");
  });

  it("missing digest without byte proof stays unknown", () => {
    expect(compareSideEvidence(undefined, "a", "s1", "s2")).toBe("unknown");
    expect(compareSideEvidence(undefined, "a")).toBe("unknown");
  });
});

describe("byte-aware movement attribution (DM-1937)", () => {
  it("PROVES the oracle when our PNG is byte-identical and Chrome's differs sub-digest", () => {
    // The decisive CI case: Chrome's expected.png moved across two runs of one
    // commit while actual.png was byte-identical — with all four perceptual
    // digests EQUAL. Digest-only attribution said "neither"; byte identity
    // exonerates our side and pins the movement on the oracle.
    const r = attributeMovementWithBytes("d", "d", "d", "d",
      { expectedBefore: "e1", expectedAfter: "e2", actualBefore: "a1", actualAfter: "a1" });
    expect(r.verdict).toBe("oracle");
    expect(r.proven).toBe(true);
    expect(r.expected).toBe("sub-digest");
    expect(r.actual).toBe("byte-identical");
    // ...and the digest-only path is blind to it, which is why it was upgraded.
    expect(attributeMovement("d", "d", "d", "d")).toBe("neither");
  });

  it("PROVES the renderer symmetrically", () => {
    const r = attributeMovementWithBytes("d", "d", "d", "d",
      { expectedBefore: "e1", expectedAfter: "e1", actualBefore: "a1", actualAfter: "a2" });
    expect(r.verdict).toBe("renderer");
    expect(r.proven).toBe(true);
  });

  it("byte identity on a side wins even over a 'moved' digest on the other", () => {
    const r = attributeMovementWithBytes("e1", "e2", "d", "d",
      { actualBefore: "a1", actualAfter: "a1" });
    expect(r.verdict).toBe("oracle");
    expect(r.proven).toBe(true);
    expect(r.expected).toBe("moved");
  });

  it("both byte-identical is a PROVEN neither — indicting the comparator, not the images", () => {
    const r = attributeMovementWithBytes("d", "d", "d", "d",
      { expectedBefore: "e1", expectedAfter: "e1", actualBefore: "a1", actualAfter: "a1" });
    expect(r.verdict).toBe("neither");
    expect(r.proven).toBe(true);
  });

  it("degrades to exactly the digest-only semantics when no shas are recorded", () => {
    for (const [eb, ea, ab, aa] of [
      ["x", "y", "z", "z"], ["x", "x", "z", "w"], ["x", "y", "z", "w"],
      ["x", "x", "z", "z"], [undefined, "y", "z", "z"],
    ] as const) {
      const r = attributeMovementWithBytes(eb, ea, ab, aa);
      expect(r.verdict).toBe(attributeMovement(eb, ea, ab, aa));
      expect(r.proven).toBe(false);
    }
  });

  it("bytes differing on both sides proves nothing — AA jitter is bytewise change", () => {
    const r = attributeMovementWithBytes("d", "d", "d", "d",
      { expectedBefore: "e1", expectedAfter: "e2", actualBefore: "a1", actualAfter: "a2" });
    expect(r.verdict).toBe("neither");
    expect(r.proven).toBe(false);
    expect(r.expected).toBe("sub-digest");
    expect(r.actual).toBe("sub-digest");
  });
});
