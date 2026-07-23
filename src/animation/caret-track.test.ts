import { describe, expect, it, vi } from "vitest";
import type { CapturedElement, TextSegment } from "../capture/types.js";
import { CARET_BLINK_MS, DEFAULT_SELECTION_COLOR, resolveTextTrack, textTrackMarkup, type ResolvedTextTrack } from "./caret-track.js";
import { generateAnimatedSvg } from "./animator.js";

function el(opts: Partial<CapturedElement> & { tag: string }): CapturedElement {
  return {
    text: "",
    x: 0, y: 0, width: 100, height: 20,
    children: [],
    styles: { fontSize: "16px", fontFamily: "Helvetica, sans-serif", fontWeight: "400" } as CapturedElement["styles"],
    ...opts,
  } as CapturedElement;
}

function seg(opts: Partial<TextSegment> & { text: string; x: number; y: number }): TextSegment {
  return { width: 0, height: 18, ...opts } as TextSegment;
}

// "abcd" on one line: chars at x = 10, 20, 30, 40; right edge 50.
function tree(): CapturedElement[] {
  return [el({
    tag: "div", animId: "line", fontAscent: 12, fontDescent: 4,
    textSegments: [seg({ text: "abcd", x: 10, y: 100, width: 40, xOffsets: [10, 20, 30, 40] })],
  })];
}

describe("resolveTextTrack", () => {
  it("resolves park/move waypoints, hides, and selections in time order", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      events: [
        { type: "move", t: 900, charOffset: 2 },
        { type: "park", t: 100, charOffset: 0 },
        { type: "hide", t: 1500 },
        { type: "select", t: 400, charStart: 1, charEnd: 3, sweepMs: 200 },
        { type: "clearSelection", t: 1200 },
      ],
    });
    expect(track.waypoints.map((w) => w.t)).toEqual([100, 900]);
    expect(track.waypoints[0].point.x).toBe(10);
    expect(track.waypoints[1].point.x).toBe(30);
    expect(track.hides).toEqual([1500]);
    expect(track.selections).toHaveLength(1);
    expect(track.selections[0].clearT).toBe(1200);
    expect(track.selections[0].color).toBe(DEFAULT_SELECTION_COLOR);
    expect(track.shape).toBe("bar");
    expect(track.blinkMs).toBe(CARET_BLINK_MS);
  });

  it("skips unresolvable events with a warning instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const track = resolveTextTrack(tree(), {
        target: { animId: "line" },
        events: [
          { type: "park", t: 0, charOffset: 99 },
          { type: "select", t: 100, charStart: 90, charEnd: 95 },
          { type: "park", t: 200, charOffset: 1 },
        ],
      });
      expect(track.waypoints).toHaveLength(1);
      expect(track.selections).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("honors a per-event target override", () => {
    const roots = [
      ...tree(),
      el({ tag: "b", animId: "other", fontAscent: 10, fontDescent: 2, textSegments: [seg({ text: "x", x: 200, y: 50, width: 8, xOffsets: [200] })] }),
    ];
    const track = resolveTextTrack(roots, {
      target: { animId: "line" },
      events: [
        { type: "park", t: 0, charOffset: 0 },
        { type: "move", t: 500, charOffset: 0, target: { animId: "other" } },
      ],
    });
    expect(track.waypoints[0].point.x).toBe(10);
    expect(track.waypoints[1].point.x).toBe(200);
  });
});

describe("textTrackMarkup — caret emission", () => {
  const TOTAL = 2000;

  function barTrack(): ResolvedTextTrack {
    return resolveTextTrack(tree(), {
      target: { animId: "line" },
      events: [
        { type: "park", t: 500, charOffset: 0 },
        { type: "move", t: 1000, charOffset: 4 },
        { type: "hide", t: 1600 },
      ],
    });
  }

  it("emits step-end position waypoints in global timeline percents", () => {
    const m = textTrackMarkup(barTrack(), TOTAL);
    // Position track: park at 25% (500/2000) at x=10, move at 50% to the
    // end-of-text edge x=50; y = baseline 112 − ascent 12 = 100.
    expect(m).toMatch(/@keyframes tt-pos-\w+\{0%\{transform:translate\(10px,100px\)\}25%\{transform:translate\(10px,100px\)\}50%\{transform:translate\(50px,100px\)\}100%\{transform:translate\(50px,100px\)\}\}/);
    expect(m).toMatch(/tt-pos-\w+ 2\.00s step-end infinite/);
  });

  it("emits the visibility windows (hidden before first park, off at hide)", () => {
    const m = textTrackMarkup(barTrack(), TOTAL);
    expect(m).toMatch(/@keyframes tt-vis-\w+\{0%\{opacity:0\}25%\{opacity:1\}50%\{opacity:1\}80%\{opacity:0\}100%\{opacity:0\}\}/);
  });

  it("emits the standard ~1.06s blink cycle on a nested group", () => {
    const m = textTrackMarkup(barTrack(), TOTAL);
    expect(m).toMatch(/@keyframes tt-blink-\w+\{0%\{opacity:1\}50%\{opacity:0\}100%\{opacity:1\}\}/);
    expect(m).toMatch(/tt-blink-\w+ 1\.06s step-end infinite/);
  });

  it("bar caret geometry: 2px wide, font-box tall", () => {
    const m = textTrackMarkup(barTrack(), TOTAL);
    expect(m).toContain('<rect class="tt-caret" width="2" height="16"');
    expect(m).not.toContain("fill-opacity");
  });

  it("block caret: one cell wide, translucent (fill-opacity 0.5)", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      shape: "block",
      events: [{ type: "park", t: 0, charOffset: 1 }],
    });
    const m = textTrackMarkup(track, TOTAL);
    // Cell = char 'b' advance (30 − 20 = 10).
    expect(m).toContain('<rect class="tt-caret" width="10" height="16"');
    expect(m).toContain('fill-opacity="0.5"');
  });

  it("underscore caret sits on the baseline", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      shape: "underscore",
      events: [{ type: "park", t: 0, charOffset: 0 }],
    });
    const m = textTrackMarkup(track, TOTAL);
    // Baseline y = 112; thickness = max(1, round(16/12)) = 1.
    expect(m).toMatch(/translate\(10px,112px\)/);
    expect(m).toContain('height="1"');
  });

  it("scales the caret rect when a waypoint's metrics differ", () => {
    const roots = [
      ...tree(),
      el({ tag: "h1", animId: "big", fontAscent: 24, fontDescent: 8, styles: { fontSize: "32px", fontFamily: "Helvetica", fontWeight: "700" } as CapturedElement["styles"], textSegments: [seg({ text: "T", x: 300, y: 10, width: 20, xOffsets: [300] })] }),
    ];
    const track = resolveTextTrack(roots, {
      target: { animId: "line" },
      events: [
        { type: "park", t: 0, charOffset: 0 },
        { type: "move", t: 1000, charOffset: 0, target: { animId: "big" } },
      ],
    });
    const m = textTrackMarkup(track, TOTAL);
    // Base bar is 16 tall; the h1 box is 32 tall → scale(1,2) folded in.
    expect(m).toContain("scale(1,2)");
  });

  it("block-invert: solid block + an inverse-colored glyph path per covered char, swapped at waypoints", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      shape: "block",
      invert: true,
      color: "#ff0000", // block ink
      invertTextColor: "#0000ff", // inverse glyph ink
      events: [
        { type: "park", t: 0, charOffset: 0 }, // covers 'a'
        { type: "move", t: 1000, charOffset: 1 }, // covers 'b'
      ],
    });
    // Each waypoint carries the covered glyph.
    expect(track.invert).toBe(true);
    expect(track.waypoints[0].glyph?.char).toBe("a");
    expect(track.waypoints[1].glyph?.char).toBe("b");

    const m = textTrackMarkup(track, TOTAL);
    // A shared blink group wraps per-waypoint layers.
    expect(m).toContain('class="tt-blink"');
    expect(m).toMatch(/@keyframes tt-blink-\w+\{0%\{opacity:1\}50%\{opacity:0\}100%\{opacity:1\}\}/);
    // Two per-waypoint layers, each its own step-end visibility window.
    const layers = m.match(/class="tt-ivis"/g);
    expect(layers).toHaveLength(2);
    expect(m).toMatch(/@keyframes tt-ivis-\w+-0\{0%\{opacity:1\}50%\{opacity:0\}100%\{opacity:0\}\}/);
    expect(m).toMatch(/@keyframes tt-ivis-\w+-1\{0%\{opacity:0\}50%\{opacity:1\}100%\{opacity:1\}\}/);
    // The block is SOLID (no fill-opacity) in the track color, one cell wide.
    expect(m).toContain('<rect class="tt-caret" x="10" y="100" width="10" height="16" fill="#ff0000"/>');
    expect(m).not.toContain("fill-opacity");
    // The inverse glyph path is emitted in the inverse ink (renderTextAsPath
    // wraps the glyph <use>s in a group with fill = invertTextColor).
    expect(m).toContain('fill="#0000ff"');
    expect(m).toMatch(/<use href="#g\d+"/);
    // Glyph swap: 'a' aria-label at waypoint 0's cell, 'b' at waypoint 1's.
    expect(m).toContain('aria-label="a"');
    expect(m).toContain('aria-label="b"');
  });

  it("block-invert is opt-in: default block caret stays byte-identical", () => {
    const events = [{ type: "park" as const, t: 0, charOffset: 1 }];
    const plain = textTrackMarkup(resolveTextTrack(tree(), { target: { animId: "line" }, shape: "block", events }), TOTAL);
    const withInvertFalse = textTrackMarkup(resolveTextTrack(tree(), { target: { animId: "line" }, shape: "block", invert: false, events }), TOTAL);
    expect(withInvertFalse).toBe(plain);
    // Default block caret is still the translucent 0.5-alpha cell.
    expect(plain).toContain('fill-opacity="0.5"');
    // The default path is the moving-rect caret, not the per-waypoint invert
    // layers (the plain caret keeps its own `tt-blink-<uid>` keyframe, so key
    // off the invert-only group classes).
    expect(plain).not.toContain('class="tt-blink"');
    expect(plain).not.toContain("tt-ivis");
  });

  it("block-invert over a non-block shape is a no-op (no inversion, no glyph)", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      shape: "bar",
      invert: true,
      events: [{ type: "park", t: 0, charOffset: 0 }],
    });
    // No covered glyph resolved for a bar caret.
    expect(track.waypoints[0].glyph).toBeUndefined();
    const m = textTrackMarkup(track, TOTAL);
    expect(m).not.toContain("tt-ivis");
    expect(m).toContain('<rect class="tt-caret" width="2"');
  });

  it("returns empty markup for an empty track or zero duration", () => {
    const track = resolveTextTrack(tree(), { target: { animId: "line" }, events: [] });
    expect(textTrackMarkup(track, TOTAL)).toBe("");
    expect(textTrackMarkup(barTrack(), 0)).toBe("");
  });
});

describe("textTrackMarkup — selection emission", () => {
  const TOTAL = 2000;

  it("sweeps per-char width keyframes across the exact painted edges", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      events: [{ type: "select", t: 400, charStart: 1, charEnd: 3, sweepMs: 200 }],
    });
    const m = textTrackMarkup(track, TOTAL);
    // Rect anchored at 'b' (x=20), font-box top/height.
    expect(m).toContain('<rect class="tt-sel" x="20" y="100" width="0.01" height="16"');
    expect(m).toContain(`fill="${DEFAULT_SELECTION_COLOR}"`);
    // Hidden until 20% (400ms), then per-char steps: 'b' swept at 25%
    // (width 10 = edge 30 − x 20), 'c' at 30% (width 20), held to 100%.
    expect(m).toMatch(/@keyframes tt-sel-\w+-0-0\{0%\{width:0\.01px\}20%\{width:0\.01px\}25%\{width:10px\}30%\{width:20px\}100%\{width:20px\}\}/);
    expect(m).toMatch(/tt-sel-\w+-0-0 2\.00s step-end infinite/);
  });

  it("clears the selection on command (width snaps back hidden)", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      events: [
        { type: "select", t: 200, charStart: 0, charEnd: 2, sweepMs: 0 },
        { type: "clearSelection", t: 1000 },
      ],
    });
    const m = textTrackMarkup(track, TOTAL);
    // Appears fully at 10%, clears at 50%, stays hidden to 100%.
    expect(m).toMatch(/\{0%\{width:0\.01px\}10%\{width:0\.01px\}10%\{width:20px\}50%\{width:0\.01px\}100%\{width:0\.01px\}\}/);
  });

  it("a range across wrapped lines sweeps one rect per segment, sequentially", () => {
    const roots = [el({
      tag: "p", animId: "wrap", fontAscent: 12, fontDescent: 4,
      textSegments: [
        seg({ text: "ab", x: 10, y: 100, width: 20, xOffsets: [10, 20] }),
        seg({ text: "cd", x: 10, y: 124, width: 22, xOffsets: [10, 21] }),
      ],
    })];
    const track = resolveTextTrack(roots, {
      target: { animId: "wrap" },
      events: [{ type: "select", t: 0, charStart: 1, charEnd: 4, sweepMs: 300 }],
    });
    const m = textTrackMarkup(track, TOTAL);
    // Two rects; line 1 covers 'b' (1 char, swept by t=100 → 5%), line 2
    // starts at t=100 and finishes at t=300 (15%).
    const rects = m.match(/<rect class="tt-sel"/g);
    expect(rects).toHaveLength(2);
    expect(m).toContain('y="100"');
    expect(m).toContain('y="124"');
    expect(m).toMatch(/tt-sel-\w+-0-1\{0%\{width:0\.01px\}5%\{width:0\.01px\}10%\{width:11px\}15%\{width:22px\}100%\{width:22px\}\}/);
  });

  it("uses a custom selection color when given", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      selectionColor: "#ff000055",
      events: [{ type: "select", t: 0, charStart: 0, charEnd: 1 }],
    });
    expect(textTrackMarkup(track, TOTAL)).toContain('fill="#ff000055"');
  });
});

describe("generateAnimatedSvg wiring", () => {
  it("layers text tracks above frame content and below the cursor overlay; omitting the field changes nothing", () => {
    const track = resolveTextTrack(tree(), {
      target: { animId: "line" },
      events: [
        { type: "park", t: 100, charOffset: 0 },
        { type: "select", t: 300, charStart: 0, charEnd: 2, sweepMs: 100 },
      ],
    });
    const base = {
      width: 200, height: 120,
      frames: [{ svgContent: "<rect width='200' height='120' fill='#fff'/>", duration: 1000 }],
      cursorOverlay: { events: [{ type: "show" as const, t: 0, x: 5, y: 5 }] },
    };
    const withTrack = generateAnimatedSvg({ ...base, textTracks: [track] });
    expect(withTrack).toContain('<g class="text-track"');
    // Above the frame groups…
    expect(withTrack.indexOf('<g class="text-track"')).toBeGreaterThan(withTrack.indexOf('<g class="f f-0"'));
    // …and below (before) the cursor overlay group.
    expect(withTrack.indexOf('<g class="text-track"')).toBeLessThan(withTrack.indexOf('<g class="cursor-overlay"'));
    // Selection rects paint before the caret inside the track group.
    expect(withTrack.indexOf('class="tt-sel"')).toBeLessThan(withTrack.indexOf('class="tt-caret"'));

    // No textTracks (or an empty list) → byte-identical to the pre-field output.
    const without = generateAnimatedSvg(base);
    expect(generateAnimatedSvg({ ...base, textTracks: [] })).toBe(without);
    expect(without).not.toContain("text-track");
  });
});
