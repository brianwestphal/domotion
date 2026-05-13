import { describe, expect, it } from "vitest";

import {
  parseScrollPattern,
  ScrollPatternError,
  type AbsoluteTarget,
  type DeltaTarget,
  type FlatSegment,
  type PauseAction,
  type ScrollAction,
} from "./pattern.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function flatSeg(input: string): FlatSegment {
  const p = parseScrollPattern(input);
  expect(p.segments).toHaveLength(1);
  const s = p.segments[0];
  expect(s.kind).toBe("flat");
  return s as FlatSegment;
}

function onlyAction(input: string): ScrollAction | PauseAction {
  const seg = flatSeg(input);
  expect(seg.actions).toHaveLength(1);
  return seg.actions[0];
}

// ── Basic scroll deltas ────────────────────────────────────────────────────

describe("parseScrollPattern: basic deltas", () => {
  it("bare px is a positive delta with no direction", () => {
    const a = onlyAction("720px") as ScrollAction;
    expect(a.kind).toBe("scroll");
    expect(a.direction).toBeUndefined();
    expect((a.target as DeltaTarget).signedLength).toEqual({ sign: 1, value: 720, unit: "px" });
    expect(a.durationMs).toBeUndefined();
    expect(a.easing).toBeUndefined();
  });

  it("bare percentage is also a delta", () => {
    const a = onlyAction("50%") as ScrollAction;
    expect((a.target as DeltaTarget).signedLength).toEqual({ sign: 1, value: 50, unit: "%" });
  });

  it("negative delta", () => {
    const a = onlyAction("-100px") as ScrollAction;
    expect((a.target as DeltaTarget).signedLength).toEqual({ sign: -1, value: 100, unit: "px" });
  });

  it("explicit direction prefix on delta", () => {
    const a = onlyAction("down:720px") as ScrollAction;
    expect(a.direction).toBe("down");
    expect((a.target as DeltaTarget).signedLength).toEqual({ sign: 1, value: 720, unit: "px" });
  });

  it("up direction with positive delta", () => {
    const a = onlyAction("up:300px") as ScrollAction;
    expect(a.direction).toBe("up");
    expect((a.target as DeltaTarget).signedLength).toEqual({ sign: 1, value: 300, unit: "px" });
  });

  it("right direction with delta", () => {
    const a = onlyAction("right:400px") as ScrollAction;
    expect(a.direction).toBe("right");
  });

  it("left direction with delta", () => {
    const a = onlyAction("left:200px") as ScrollAction;
    expect(a.direction).toBe("left");
  });
});

// ── Absolute targets (anchors + arithmetic) ────────────────────────────────

describe("parseScrollPattern: absolute targets", () => {
  it("bare anchor `top`", () => {
    const a = onlyAction("top") as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect(t.kind).toBe("absolute");
    expect(t.anchor).toEqual({ kind: "named", name: "top" });
    expect(t.axisSuffix).toBeUndefined();
    expect(t.offsets).toEqual([]);
  });

  it("bare anchor `bottom`", () => {
    const a = onlyAction("bottom") as ScrollAction;
    expect((a.target as AbsoluteTarget).anchor).toEqual({ kind: "named", name: "bottom" });
  });

  it("anchor with single + offset", () => {
    const a = onlyAction("top + 200px") as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect(t.offsets).toEqual([{ op: "+", length: { value: 200, unit: "px" } }]);
  });

  it("anchor with single - offset", () => {
    const a = onlyAction("bottom - 1000px") as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect(t.offsets).toEqual([{ op: "-", length: { value: 1000, unit: "px" } }]);
  });

  it("anchor with chained offsets", () => {
    const a = onlyAction("start + 100px - 50px + 25%") as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect(t.offsets).toEqual([
      { op: "+", length: { value: 100, unit: "px" } },
      { op: "-", length: { value: 50,  unit: "px" } },
      { op: "+", length: { value: 25,  unit: "%"  } },
    ]);
  });

  it("axis suffix .x", () => {
    const a = onlyAction("start.x + 1400px") as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect(t.axisSuffix).toBe("x");
    expect(t.offsets).toEqual([{ op: "+", length: { value: 1400, unit: "px" } }]);
  });

  it("axis suffix .y is parsed and preserved", () => {
    const a = onlyAction("start.y + 1400px") as ScrollAction;
    expect((a.target as AbsoluteTarget).axisSuffix).toBe("y");
  });

  it("invalid axis suffix throws", () => {
    expect(() => parseScrollPattern("start.z + 1400px")).toThrow(ScrollPatternError);
  });

  it("direction prefix + absolute target", () => {
    const a = onlyAction("up:top + 200px") as ScrollAction;
    expect(a.direction).toBe("up");
    const t = a.target as AbsoluteTarget;
    expect(t.anchor).toEqual({ kind: "named", name: "top" });
    expect(t.offsets).toEqual([{ op: "+", length: { value: 200, unit: "px" } }]);
  });

  it("`down:bottom` redundancy is accepted", () => {
    const a = onlyAction("down:bottom") as ScrollAction;
    expect(a.direction).toBe("down");
    expect((a.target as AbsoluteTarget).anchor).toEqual({ kind: "named", name: "bottom" });
  });
});

// ── selector(...) ───────────────────────────────────────────────────────────

describe("parseScrollPattern: selector(...)", () => {
  it("bare selector", () => {
    const a = onlyAction('selector(".footer")') as ScrollAction;
    expect((a.target as AbsoluteTarget).anchor).toEqual({ kind: "selector", cssSelector: ".footer" });
  });

  it("selector with `:has()` containing a comma — quoted disambiguates", () => {
    const a = onlyAction('selector(".a:has(.b, .c)")') as ScrollAction;
    expect((a.target as AbsoluteTarget).anchor).toEqual({ kind: "selector", cssSelector: ".a:has(.b, .c)" });
  });

  it("selector with axis suffix .x", () => {
    const a = onlyAction('selector(".panel").x + 200px') as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect(t.anchor).toEqual({ kind: "selector", cssSelector: ".panel" });
    expect(t.axisSuffix).toBe("x");
    expect(t.offsets).toEqual([{ op: "+", length: { value: 200, unit: "px" } }]);
  });

  it("selector + arithmetic", () => {
    const a = onlyAction('selector(".cta") - 50px') as ScrollAction;
    const t = a.target as AbsoluteTarget;
    expect((t.anchor as { kind: "selector"; cssSelector: string }).cssSelector).toBe(".cta");
    expect(t.offsets).toEqual([{ op: "-", length: { value: 50, unit: "px" } }]);
  });

  it("unterminated string in selector throws", () => {
    expect(() => parseScrollPattern('selector(".footer')).toThrow(ScrollPatternError);
  });

  it("unquoted argument inside selector(...) throws", () => {
    expect(() => parseScrollPattern("selector(.footer)")).toThrow(ScrollPatternError);
  });
});

// ── Duration suffix (/Ns) ──────────────────────────────────────────────────

describe("parseScrollPattern: /<duration> suffix", () => {
  it("attaches to delta", () => {
    const a = onlyAction("720px/3s") as ScrollAction;
    expect(a.durationMs).toBe(3000);
  });

  it("attaches to absolute target", () => {
    const a = onlyAction("up:top + 200px/2s") as ScrollAction;
    expect(a.durationMs).toBe(2000);
  });

  it("supports ms unit", () => {
    const a = onlyAction("100px/500ms") as ScrollAction;
    expect(a.durationMs).toBe(500);
  });

  it("missing duration after / throws", () => {
    expect(() => parseScrollPattern("720px/")).toThrow(ScrollPatternError);
  });
});

// ── Easing suffix [...] ────────────────────────────────────────────────────

describe("parseScrollPattern: [easing] suffix", () => {
  it("named easing", () => {
    const a = onlyAction("720px[ease-in]") as ScrollAction;
    expect(a.easing).toEqual({ kind: "named", name: "ease-in" });
  });

  it("named easing after duration", () => {
    const a = onlyAction("720px/3s[ease-out]") as ScrollAction;
    expect(a.durationMs).toBe(3000);
    expect(a.easing).toEqual({ kind: "named", name: "ease-out" });
  });

  it("cubic-bezier", () => {
    const a = onlyAction("720px/2s[cubic-bezier(0.25, 0.1, 0.25, 1)]") as ScrollAction;
    expect(a.easing).toEqual({ kind: "cubic-bezier", values: [0.25, 0.1, 0.25, 1] });
  });

  it("negative cubic-bezier value", () => {
    const a = onlyAction("720px[cubic-bezier(-0.5, 0, 1, 1)]") as ScrollAction;
    expect(a.easing).toEqual({ kind: "cubic-bezier", values: [-0.5, 0, 1, 1] });
  });

  it("unknown easing throws", () => {
    expect(() => parseScrollPattern("720px[ease-wibble]")).toThrow(ScrollPatternError);
  });
});

// ── Pauses ──────────────────────────────────────────────────────────────────

describe("parseScrollPattern: pauses", () => {
  it("bare duration is a pause", () => {
    const a = onlyAction("2s") as PauseAction;
    expect(a.kind).toBe("pause");
    expect(a.durationMs).toBe(2000);
  });

  it("ms-precision pause", () => {
    const a = onlyAction("250ms") as PauseAction;
    expect(a.durationMs).toBe(250);
  });

  it("`pause:` prefix is decorative", () => {
    const a = onlyAction("pause:2s") as PauseAction;
    expect(a.kind).toBe("pause");
    expect(a.durationMs).toBe(2000);
  });

  it("`pause:` mid-pattern is allowed", () => {
    const seg = flatSeg("720px,pause:2s,720px");
    expect(seg.actions).toHaveLength(3);
    expect(seg.actions[1].kind).toBe("pause");
  });
});

// ── Sequences (flat segments) ──────────────────────────────────────────────

describe("parseScrollPattern: flat-segment sequences", () => {
  it("scroll, pause, scroll", () => {
    const seg = flatSeg("720px,2s,720px");
    expect(seg.actions.map((a) => a.kind)).toEqual(["scroll", "pause", "scroll"]);
    expect(seg.until).toBeUndefined();
  });

  it("three consecutive scrolls without pauses", () => {
    const seg = flatSeg("100px,200px,300px");
    expect(seg.actions).toHaveLength(3);
    expect(seg.actions.every((a) => a.kind === "scroll")).toBe(true);
  });

  it("user's example `100px,200px,1s,100px`", () => {
    const seg = flatSeg("100px,200px,1s,100px");
    expect(seg.actions.map((a) => a.kind)).toEqual(["scroll", "scroll", "pause", "scroll"]);
  });

  it("normalised example with directions, durations, pauses", () => {
    const seg = flatSeg("down:720px/3s,pause:2s,up:top + 200px/2s,pause:4s");
    expect(seg.actions).toHaveLength(4);
    const s1 = seg.actions[0] as ScrollAction;
    expect(s1.direction).toBe("down");
    expect(s1.durationMs).toBe(3000);
    const s3 = seg.actions[2] as ScrollAction;
    expect(s3.direction).toBe("up");
    expect((s3.target as AbsoluteTarget).anchor).toEqual({ kind: "named", name: "top" });
  });

  it("trailing `,` throws", () => {
    expect(() => parseScrollPattern("720px,2s,")).toThrow(ScrollPatternError);
  });

  it("empty input throws", () => {
    expect(() => parseScrollPattern("")).toThrow(ScrollPatternError);
    expect(() => parseScrollPattern("   ")).toThrow(ScrollPatternError);
  });
});

// ── `until` clause ──────────────────────────────────────────────────────────

describe("parseScrollPattern: until clause", () => {
  it("until anchor (position)", () => {
    const seg = flatSeg("720px,2s until bottom");
    expect(seg.until?.kind).toBe("position");
    if (seg.until?.kind === "position") {
      expect(seg.until.target.anchor).toEqual({ kind: "named", name: "bottom" });
    }
  });

  it("until anchor + offset", () => {
    const seg = flatSeg("720px,2s until bottom - 1000px");
    if (seg.until?.kind === "position") {
      expect(seg.until.target.offsets).toEqual([{ op: "-", length: { value: 1000, unit: "px" } }]);
    }
  });

  it("until selector(...)", () => {
    const seg = flatSeg('720px until selector(".footer")');
    if (seg.until?.kind === "position") {
      expect(seg.until.target.anchor).toEqual({ kind: "selector", cssSelector: ".footer" });
    }
  });

  it("until N times (count)", () => {
    const seg = flatSeg("720px,2s until 5 times");
    expect(seg.until).toEqual({ kind: "count", count: 5 });
  });

  it("until 1 times (edge case)", () => {
    const seg = flatSeg("720px until 1 times");
    expect(seg.until).toEqual({ kind: "count", count: 1 });
  });

  it("until 0 times throws (positive integer required)", () => {
    expect(() => parseScrollPattern("720px until 0 times")).toThrow(ScrollPatternError);
  });

  it("until -3 times throws", () => {
    expect(() => parseScrollPattern("720px until -3 times")).toThrow(ScrollPatternError);
  });

  it("until 3 (without `times`) throws", () => {
    expect(() => parseScrollPattern("720px until 3")).toThrow(ScrollPatternError);
  });

  it("until without condition throws", () => {
    expect(() => parseScrollPattern("720px until")).toThrow(ScrollPatternError);
  });

  it("multi-action body with until", () => {
    const seg = flatSeg("720px,2s,200px,3s until bottom");
    expect(seg.actions).toHaveLength(4);
    expect(seg.until?.kind).toBe("position");
  });
});

// ── Bracketed segments + multi-group ───────────────────────────────────────

describe("parseScrollPattern: bracketed segments", () => {
  it("bracketed group: until INSIDE parens belongs to inner segment", () => {
    const p = parseScrollPattern("(720px,2s until bottom)");
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0].kind).toBe("bracketed");
    if (p.segments[0].kind === "bracketed") {
      // The outer bracketed has no until of its own…
      expect(p.segments[0].until).toBeUndefined();
      // …because the until was inside the parens, on the inner flat segment.
      expect(p.segments[0].pattern.segments).toHaveLength(1);
      const inner = p.segments[0].pattern.segments[0] as FlatSegment;
      expect(inner.until?.kind).toBe("position");
    }
  });

  it("bracketed group: until OUTSIDE parens belongs to bracketed segment", () => {
    const p = parseScrollPattern("(720px,2s) until bottom");
    expect(p.segments).toHaveLength(1);
    if (p.segments[0].kind === "bracketed") {
      expect(p.segments[0].until?.kind).toBe("position");
      const inner = p.segments[0].pattern.segments[0] as FlatSegment;
      expect(inner.until).toBeUndefined();
    }
  });

  it("two bracketed groups, sequential", () => {
    const p = parseScrollPattern("(720px,2s until bottom - 1000px), (100px,1s until bottom)");
    expect(p.segments).toHaveLength(2);
    expect(p.segments.every((s) => s.kind === "bracketed")).toBe(true);
  });

  it("two flat segments separated by until→comma boundary", () => {
    // `A,B until X, C,D` — until X terminates segment 1, then `,` starts segment 2.
    const p = parseScrollPattern("100px,2s until bottom - 1000px, 50px,1s");
    expect(p.segments).toHaveLength(2);
    const s1 = p.segments[0] as FlatSegment;
    expect(s1.actions).toHaveLength(2);
    expect(s1.until?.kind).toBe("position");
    const s2 = p.segments[1] as FlatSegment;
    expect(s2.actions).toHaveLength(2);
    expect(s2.until).toBeUndefined();
  });

  it("user's multi-group example", () => {
    const p = parseScrollPattern("(720px,2s,200px,3s until bottom - 1000px), (100px,200px,1s,100px until bottom)");
    expect(p.segments).toHaveLength(2);
    if (p.segments[0].kind === "bracketed") {
      const inner = p.segments[0].pattern;
      expect(inner.segments).toHaveLength(1);
      const flat = inner.segments[0] as FlatSegment;
      expect(flat.actions).toHaveLength(4);
      expect(flat.until?.kind).toBe("position");
    }
    if (p.segments[1].kind === "bracketed") {
      const inner = p.segments[1].pattern;
      const flat = inner.segments[0] as FlatSegment;
      expect(flat.actions).toHaveLength(4);
      expect(flat.until?.kind).toBe("position");
    }
  });

  it("nested groups", () => {
    const p = parseScrollPattern("((720px,2s until 3 times) until bottom)");
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0].kind).toBe("bracketed");
  });

  it("unmatched ( throws", () => {
    expect(() => parseScrollPattern("(720px,2s")).toThrow(ScrollPatternError);
  });

  it("unmatched ) throws", () => {
    expect(() => parseScrollPattern("720px)")).toThrow(ScrollPatternError);
  });

  it("empty group throws", () => {
    expect(() => parseScrollPattern("()")).toThrow(ScrollPatternError);
  });
});

// ── Error messages / positions ─────────────────────────────────────────────

describe("parseScrollPattern: error reporting", () => {
  it("unknown identifier in action position", () => {
    try {
      parseScrollPattern("wibble");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScrollPatternError);
      expect((e as ScrollPatternError).position).toBe(0);
    }
  });

  it("unknown unit after number", () => {
    try {
      parseScrollPattern("720pt");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScrollPatternError);
      const err = e as ScrollPatternError;
      expect(err.message).toContain('Unknown unit "pt"');
    }
  });

  it("unexpected character", () => {
    try {
      parseScrollPattern("720px@3s");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScrollPatternError);
      expect((e as ScrollPatternError).message).toContain("Unexpected character");
    }
  });
});
