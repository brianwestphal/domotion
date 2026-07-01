import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { type CursorAtResolver, type CursorOverlay, type SelectorResolver, cursorAtPoint, cursorOverlayMarkup, resolveCursorScript } from "./cursor-overlay.js";

const TOTAL = 4000;
const FRAME_STARTS = [0, 1500, 3000];

// Minimal captured element for hit-test tests.
function el(x: number, y: number, w: number, h: number, cursor?: string, children: CapturedElement[] = []): CapturedElement {
  return { tag: "div", text: "", x, y, width: w, height: h, cursor, children } as unknown as CapturedElement;
}

describe("resolveCursorScript: position keyframes", () => {
  it("anchors a hidden keyframe at t=0 even when the script starts later", () => {
    const overlay: CursorOverlay = {
      events: [{ type: "show", t: 500, x: 100, y: 200 }],
    };
    const r = resolveCursorScript(overlay, TOTAL, FRAME_STARTS, null);
    expect(r.positions[0]).toMatchObject({ t: 0, visible: false });
    expect(r.positions.find((p) => p.t === 500)).toMatchObject({ x: 100, y: 200, visible: true });
    expect(r.positions[r.positions.length - 1].t).toBe(TOTAL);
  });

  it("resolves `to` (absolute), `by` (relative), and `selector` move targets", () => {
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 10, y: 20 },
        { type: "move", t: 100, to: { x: 50, y: 60 } },
        { type: "move", t: 200, by: { dx: 10, dy: -5 } },
        { type: "move", t: 300, selector: ".btn" },
      ],
    };
    const resolveSelector: SelectorResolver = () => ({ x: 200, y: 300, w: 80, h: 24 });
    const r = resolveCursorScript(overlay, TOTAL, FRAME_STARTS, resolveSelector);
    const at100 = r.positions.find((p) => p.t === 100)!;
    const at200 = r.positions.find((p) => p.t === 200)!;
    const at300 = r.positions.find((p) => p.t === 300)!;
    expect(at100).toMatchObject({ x: 50, y: 60 });
    expect(at200).toMatchObject({ x: 60, y: 55 });
    // Center of (200, 300, 80, 24) is (240, 312).
    expect(at300).toMatchObject({ x: 240, y: 312 });
  });

  it("emits two keyframes for a duration move (start + end) so SMIL interpolates", () => {
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 0, y: 0 },
        { type: "move", t: 1000, to: { x: 100, y: 100 }, duration: 500 },
      ],
    };
    const r = resolveCursorScript(overlay, TOTAL, FRAME_STARTS, null);
    const at1000 = r.positions.find((p) => p.t === 1000)!;
    const at1500 = r.positions.find((p) => p.t === 1500)!;
    expect(at1000).toMatchObject({ x: 0, y: 0, visible: true });
    expect(at1500).toMatchObject({ x: 100, y: 100, visible: true });
  });

  it("captures clicks with the cursor's current position at the click's t", () => {
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 30, y: 40 },
        { type: "click", t: 100, button: "primary" },
        { type: "move", t: 200, to: { x: 80, y: 80 } },
        { type: "click", t: 300, button: "secondary" },
      ],
    };
    const r = resolveCursorScript(overlay, TOTAL, FRAME_STARTS, null);
    expect(r.clicks).toHaveLength(2);
    expect(r.clicks[0]).toMatchObject({ t: 100, x: 30, y: 40, button: "primary" });
    expect(r.clicks[1]).toMatchObject({ t: 300, x: 80, y: 80, button: "secondary" });
  });
});

describe("cursorOverlayMarkup: SVG emission", () => {
  it("includes a cursor-arrow group and a click pulse per click", () => {
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 50, y: 50 },
        { type: "click", t: 200, button: "primary" },
        { type: "click", t: 600, button: "secondary" },
      ],
    };
    const r = resolveCursorScript(overlay, TOTAL, FRAME_STARTS, null);
    const svg = cursorOverlayMarkup(r.positions, r.clicks, r.style, TOTAL);
    expect(svg).toContain('class="cursor-overlay"');
    expect(svg).toContain('class="cursor-arrow"');
    expect(svg).toContain('class="cursor-click cursor-click-0"');
    expect(svg).toContain('class="cursor-click cursor-click-1"');
    // Secondary click adds the right-half-disc fill.
    expect(svg).toContain('rgba(0,0,0,0.2)');
    // DM-1507: the overlay must be pure CSS — NO SMIL. SMIL runs on the SVG's own
    // timeline while the frames run on the CSS timeline; Safari pauses those two
    // clocks independently offscreen, desyncing the cursor. One timeline = no drift.
    expect(svg).not.toContain("<animate");
    expect(svg).not.toContain("repeatCount");
    expect(svg).toMatch(/@keyframes co-pos-[a-z0-9]+\{/);
    expect(svg).toMatch(/animation:co-pos-[a-z0-9]+ [\d.]+s linear infinite/);
  });

  it("re-fires click pulses on every loop iteration (DM-1510)", () => {
    // Regression: the pulse was emitted as a one-shot `... <delay>s 1 forwards`
    // animation, so it played only on the first loop and never reappeared when
    // the SVG looped — while the cursor position track (infinite) kept moving.
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 50, y: 50 },
        { type: "click", t: 1000, button: "primary" },
        { type: "click", t: 2000, button: "secondary" },
      ],
    };
    const r = resolveCursorScript(overlay, TOTAL, FRAME_STARTS, null);
    const svg = cursorOverlayMarkup(r.positions, r.clicks, r.style, TOTAL);
    // Every pulse animation must loop with the SVG: `infinite`, full-loop
    // duration, and NO one-shot iteration count / `forwards` fill.
    const pulseAnims = svg.match(/animation:co-pulse-[a-z0-9]+-\d+[a-z] [\d.]+s [^"]*/g) ?? [];
    expect(pulseAnims.length).toBeGreaterThanOrEqual(3); // 2 rings x2 + 1 secondary half
    for (const a of pulseAnims) {
      expect(a).toContain("infinite");
      expect(a).not.toContain("forwards");
      expect(a).not.toMatch(/ 1 forwards| 1$/);
      // Full-loop duration, matching the position track (TOTAL/1000 = 4s).
      expect(a).toContain(`${TOTAL / 1000}s`);
    }
    // The pulse's keyframe window must land inside the loop (peak keyframe present
    // for the t=1000 click: 1000/4000 = 25%, peak at (1000+75)/4000 ≈ 26.875%).
    expect(svg).toMatch(/@keyframes co-pulse-[a-z0-9]+-0o\{0%\{[^}]*\}25%\{/);
  });

  it("emits empty string when there are no events", () => {
    const r = resolveCursorScript({ events: [] }, TOTAL, FRAME_STARTS, null);
    const svg = cursorOverlayMarkup(r.positions, r.clicks, r.style, TOTAL);
    // Even with no events, resolveCursorScript anchors t=0 and t=total
    // (both invisible). The markup is non-empty but contains no clicks.
    expect(svg).toContain('class="cursor-overlay"');
    expect(svg).not.toContain('class="cursor-click');
  });
});

describe("cursorAtPoint: hit-test (DM-1106)", () => {
  it("returns the topmost (last-painted, deepest) element's cursor; default when none/omitted", () => {
    const tree = [
      el(0, 0, 1000, 1000, undefined, [          // body: default (omitted)
        el(10, 10, 200, 40, "pointer"),          // a link
        el(10, 60, 400, 100, "text", [           // a paragraph
          el(20, 70, 80, 20, "pointer"),         // a nested link inside the text
        ]),
      ]),
    ];
    expect(cursorAtPoint(tree, 50, 25)).toBe("pointer");   // over the link
    expect(cursorAtPoint(tree, 300, 120)).toBe("text");    // over the paragraph
    expect(cursorAtPoint(tree, 40, 78)).toBe("pointer");   // nested link wins over the paragraph
    expect(cursorAtPoint(tree, 800, 800)).toBe("default"); // only the body (omitted -> default)
    expect(cursorAtPoint(tree, 5000, 5000)).toBe("default"); // outside everything
  });
});

describe("resolveCursorScript: cursor-type timeline (DM-1106)", () => {
  // A page split at x=100: left half is a link (pointer), right half is text.
  const resolveCursorAt: CursorAtResolver = (x) => (x < 100 ? "pointer" : "text");

  it("switches the cursor keyword at the boundary the pointer crosses", () => {
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 0, y: 50 },
        { type: "move", t: 0, to: { x: 200, y: 50 }, duration: 1000 }, // slides 0->200 over x, crossing 100 at t=500
      ],
    };
    const r = resolveCursorScript(overlay, 1000, [0], null, resolveCursorAt);
    expect(r.cursorTimeline).not.toBeNull();
    const tl = r.cursorTimeline!;
    expect(tl[0]).toMatchObject({ t: 0, cursor: "pointer" });
    const cross = tl.find((e) => e.cursor === "text")!;
    expect(cross).toBeDefined();
    // Boundary x=100 at the midpoint of a 0..200 slide => ~t=500, bisection-refined.
    expect(Math.abs(cross.t - 500)).toBeLessThan(10);
  });

  it("a per-event cursor override wins over the hit-test", () => {
    const overlay: CursorOverlay = {
      events: [{ type: "show", t: 0, x: 0, y: 50, cursor: "grabbing" }],
    };
    const r = resolveCursorScript(overlay, 1000, [0], null, resolveCursorAt);
    // Even though x<100 would hit-test to "pointer", the override forces grabbing.
    expect(r.cursorTimeline!.every((e) => e.cursor == null || e.cursor === "grabbing")).toBe(true);
  });

  it("hidden windows become null timeline entries", () => {
    const overlay: CursorOverlay = {
      events: [{ type: "show", t: 200, x: 10, y: 10 }, { type: "hide", t: 600 }],
    };
    const r = resolveCursorScript(overlay, 1000, [0], null, resolveCursorAt);
    const tl = r.cursorTimeline!;
    expect(tl[0]).toMatchObject({ t: 0, cursor: null });   // hidden before the show
    expect(tl.some((e) => e.cursor === "pointer")).toBe(true); // visible after show
  });

  it("is null when no cursor resolver is supplied (back-compat single arrow)", () => {
    const overlay: CursorOverlay = { events: [{ type: "show", t: 0, x: 0, y: 0 }] };
    const r = resolveCursorScript(overlay, 1000, [0], null);
    expect(r.cursorTimeline).toBeNull();
  });
});

describe("cursorOverlayMarkup: multi-glyph (DM-1106)", () => {
  const resolveCursorAt: CursorAtResolver = (x) => (x < 100 ? "pointer" : "text");
  it("emits a cursor-pointer group with a glyph layer per distinct keyword", () => {
    const overlay: CursorOverlay = {
      events: [
        { type: "show", t: 0, x: 0, y: 50 },
        { type: "move", t: 0, to: { x: 200, y: 50 }, duration: 1000 },
      ],
    };
    const r = resolveCursorScript(overlay, 1000, [0], null, resolveCursorAt);
    const svg = cursorOverlayMarkup(r.positions, r.clicks, r.style, 1000, r.cursorTimeline);
    expect(svg).toContain('class="cursor-pointer"');
    expect(svg).not.toContain('class="cursor-arrow"'); // not the legacy path
    // DM-1507: cursor is CSS, not SMIL — no SMIL timeline that desyncs offscreen.
    expect(svg).not.toContain("<animate");
    // Two glyph layers, each toggled by a discrete (step-end) CSS opacity track.
    expect((svg.match(/co-glyph-[a-z0-9]+-\d+ [\d.]+s step-end infinite/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
