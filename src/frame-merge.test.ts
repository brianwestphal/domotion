/**
 * Unit tests for the frame merger. Uses handcrafted SVG-ish fragments that
 * exercise the identity, hoisting, and recursive-merge paths without needing
 * to capture real DOM.
 */

import { describe, it, expect } from "vitest";
import { parseSiblings, mergeFrames, structuralFingerprint } from "./frame-merge.js";

function simpleTiming(count: number) {
  // Equally spaced frames, each holding 10% with no transition.
  const startPct: number[] = [];
  const holdEndPct: number[] = [];
  const transEndPct: number[] = [];
  for (let i = 0; i < count; i++) {
    startPct.push((i / count) * 100);
    holdEndPct.push(((i + 0.9) / count) * 100);
    transEndPct.push(((i + 1) / count) * 100);
  }
  return { startPct, holdEndPct, transEndPct };
}

describe("frame-merge: parseSiblings", () => {
  it("parses a simple self-closing tag", () => {
    const r = parseSiblings(`<rect x="1" y="2"/>`);
    expect(r).toHaveLength(1);
    expect(r[0].tag).toBe("rect");
    expect(r[0].selfClosing).toBe(true);
    expect(r[0].attrs!["x"]).toBe("1");
  });

  it("parses nested elements", () => {
    const r = parseSiblings(`<g transform="translate(1,2)"><use href="#g0"/></g>`);
    expect(r).toHaveLength(1);
    expect(r[0].children).toHaveLength(1);
    expect(r[0].children![0].tag).toBe("use");
  });

  it("parses multiple siblings", () => {
    const r = parseSiblings(`<g><a/></g><rect/><circle/>`);
    expect(r).toHaveLength(3);
    expect(r.map((n) => n.tag)).toEqual(["g", "rect", "circle"]);
  });
});

describe("frame-merge: mergeFrames", () => {
  it("hoists elements identical across all frames (no timeline class)", () => {
    const frames = [
      `<g transform="translate(10,20)"><rect fill="red"/></g>`,
      `<g transform="translate(10,20)"><rect fill="red"/></g>`,
      `<g transform="translate(10,20)"><rect fill="red"/></g>`,
    ];
    const r = mergeFrames(frames, simpleTiming(3));
    // Element appears exactly once, with no class attribute.
    expect(r.merged).toContain(`<g transform="translate(10,20)">`);
    expect(r.merged.match(/<rect fill="red"/g)).toHaveLength(1);
    // No timeline CSS because it's always visible.
    expect(r.css).toBe("");
  });

  it("emits per-frame classes for elements visible in a subset of frames", () => {
    const frames = [
      `<g transform="translate(0,0)"><use href="#g1" x="0"/></g>`,
      `<g transform="translate(0,0)"><use href="#g1" x="0"/><use href="#g2" x="100"/></g>`,
      `<g transform="translate(0,0)"><use href="#g1" x="0"/><use href="#g2" x="100"/><use href="#g3" x="200"/></g>`,
    ];
    const r = mergeFrames(frames, simpleTiming(3));
    // g1 should be emitted once with no class (always visible).
    const g1Occurrences = r.merged.match(/<use href="#g1"[^/]*\/>/g) ?? [];
    expect(g1Occurrences.length).toBe(1);
    expect(g1Occurrences[0]).not.toContain("class=");
    // g2 should appear once with a timeline class (visible in frames 1,2).
    const g2Occurrences = r.merged.match(/<use href="#g2"[^/]*\/>/g) ?? [];
    expect(g2Occurrences.length).toBe(1);
    expect(g2Occurrences[0]).toContain("class=");
    // g3 should appear once with a timeline class (visible in frame 2 only).
    const g3Occurrences = r.merged.match(/<use href="#g3"[^/]*\/>/g) ?? [];
    expect(g3Occurrences.length).toBe(1);
    expect(g3Occurrences[0]).toContain("class=");
    // CSS should include 2 @keyframes blocks (one per unique timeline).
    const kfCount = (r.css.match(/@keyframes /g) ?? []).length;
    expect(kfCount).toBe(2);
  });

  it("merges wrappers with same fingerprint but differing children (typing case)", () => {
    // Simulates capturing a text input as text is typed: the wrapper <g> at the
    // same transform is logically the same text field; children accumulate.
    const frames = [
      `<g transform="translate(32,28)" role="img" aria-label="a"><use href="#gA" x="0"/></g>`,
      `<g transform="translate(32,28)" role="img" aria-label="ab"><use href="#gA" x="0"/><use href="#gB" x="10"/></g>`,
      `<g transform="translate(32,28)" role="img" aria-label="abc"><use href="#gA" x="0"/><use href="#gB" x="10"/><use href="#gC" x="20"/></g>`,
    ];
    const r = mergeFrames(frames, simpleTiming(3));
    // Wrapper <g> should appear once.
    const wrapperOpens = r.merged.match(/<g transform="translate\(32,28\)"/g) ?? [];
    expect(wrapperOpens.length).toBe(1);
    // Each <use> child appears once in the merged output.
    expect((r.merged.match(/href="#gA"/g) ?? []).length).toBe(1);
    expect((r.merged.match(/href="#gB"/g) ?? []).length).toBe(1);
    expect((r.merged.match(/href="#gC"/g) ?? []).length).toBe(1);
  });
});

describe("frame-merge: structuralFingerprint", () => {
  it("matches wrappers by transform/role even if aria-label differs", () => {
    const a = parseSiblings(`<g transform="translate(1,2)" role="img" aria-label="A"/>`)[0];
    const b = parseSiblings(`<g transform="translate(1,2)" role="img" aria-label="B"/>`)[0];
    expect(structuralFingerprint(a)).toBe(structuralFingerprint(b));
  });

  it("does not match wrappers at different positions", () => {
    const a = parseSiblings(`<g transform="translate(1,2)"/>`)[0];
    const b = parseSiblings(`<g transform="translate(3,4)"/>`)[0];
    expect(structuralFingerprint(a)).not.toBe(structuralFingerprint(b));
  });
});
