import { describe, expect, it } from "vitest";
import { type CursorOverlay, type SelectorResolver, cursorOverlayMarkup, resolveCursorScript } from "./cursor-overlay.js";

const TOTAL = 4000;
const FRAME_STARTS = [0, 1500, 3000];

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
