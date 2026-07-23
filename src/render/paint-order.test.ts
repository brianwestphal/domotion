import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { cursorAtPoint } from "../animation/cursor-overlay.js";
import { hitTestTopmost } from "./paint-order.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

type StyleOverrides = Partial<CapturedElement["styles"]>;

function el(opts: {
  tag?: string;
  x: number; y: number; w: number; h: number;
  cursor?: string;
  styles?: StyleOverrides;
  children?: CapturedElement[];
}): CapturedElement {
  return {
    tag: opts.tag ?? "div",
    text: "",
    x: opts.x, y: opts.y, width: opts.w, height: opts.h,
    cursor: opts.cursor,
    styles: { ...opts.styles } as CapturedElement["styles"],
    children: opts.children ?? [],
  } as CapturedElement;
}

// ── DM-1742: true paint-order hit-testing ───────────────────────────────────

describe("hitTestTopmost: z-index paint order (DM-1742)", () => {
  it("the ticket's stacked-windows scenario: the z-raised front window answers, not the DOM-later hidden one", () => {
    // Four full-size overlapping "windows" switched via z-index (kerf's
    // getting-started stage). The browser window (z:6, EARLIER in the DOM)
    // is visually front; the editor (z:1, later in the DOM) is hidden
    // beneath. The old DFS-last hit-test answered with the editor's code
    // area (I-beam / arrow); the viewer sees the browser window's button.
    const browserBtn = el({ x: 400, y: 500, w: 120, h: 40, cursor: "pointer" });
    const browserWin = el({
      x: 0, y: 0, w: 1000, h: 700,
      styles: { position: "absolute", zIndex: "6" },
      children: [browserBtn],
    });
    const editorCode = el({ x: 50, y: 100, w: 900, h: 500, cursor: "text" });
    const editorWin = el({
      x: 0, y: 0, w: 1000, h: 700,
      styles: { position: "absolute", zIndex: "1" },
      children: [editorCode],
    });
    const body = el({ x: 0, y: 0, w: 1000, h: 700, children: [browserWin, editorWin] });
    // Over the front window's button → hand, not the buried editor's I-beam.
    expect(cursorAtPoint([body], 450, 520)).toBe("pointer");
    // Over the front window elsewhere → its default arrow, not "text".
    expect(cursorAtPoint([body], 200, 200)).toBe("default");
  });

  it("negative z-index paints (and hit-tests) beneath in-flow siblings", () => {
    const behind = el({ x: 0, y: 0, w: 500, h: 500, cursor: "pointer", styles: { position: "absolute", zIndex: "-1" } });
    const content = el({ x: 0, y: 0, w: 500, h: 300, cursor: "text" });
    const root = el({ x: 0, y: 0, w: 500, h: 500, styles: { position: "relative", zIndex: "0" }, children: [behind, content] });
    expect(cursorAtPoint([root], 100, 100)).toBe("text");    // content covers the negative-z layer
    expect(cursorAtPoint([root], 100, 400)).toBe("pointer"); // below the content, the negative-z layer shows
  });

  it("later sibling on top (no z-index) keeps DOM order — the pre-DM-1742 behavior still holds", () => {
    const first = el({ x: 0, y: 0, w: 200, h: 200, cursor: "text" });
    const second = el({ x: 100, y: 100, w: 200, h: 200, cursor: "pointer" });
    const body = el({ x: 0, y: 0, w: 400, h: 400, children: [first, second] });
    expect(cursorAtPoint([body], 150, 150)).toBe("pointer"); // overlap → later sibling wins
    expect(cursorAtPoint([body], 50, 50)).toBe("text");
  });

  it("a nested element wins over its ancestor at the same point", () => {
    const link = el({ x: 20, y: 70, w: 80, h: 20, cursor: "pointer" });
    const para = el({ x: 10, y: 60, w: 400, h: 100, cursor: "text", children: [link] });
    const body = el({ x: 0, y: 0, w: 1000, h: 1000, children: [para] });
    expect(cursorAtPoint([body], 40, 78)).toBe("pointer");
    expect(cursorAtPoint([body], 300, 120)).toBe("text");
  });

  it("an opacity:0 element still hit-tests (browsers hit transparent boxes; kerf's hint pads rely on it)", () => {
    const pad = el({ x: 100, y: 100, w: 100, h: 40, cursor: "pointer", styles: { opacity: "0" } });
    const body = el({ x: 0, y: 0, w: 500, h: 500, cursor: "text", children: [pad] });
    expect(cursorAtPoint([body], 150, 120)).toBe("pointer");
  });
});

describe("hitTestTopmost: pointer-events / clipping (DM-1742)", () => {
  it("skips pointer-events:none elements (and their descendants, which inherit the computed value)", () => {
    // A decorative full-viewport overlay with pointer-events:none must not
    // answer every hit-test with its own (default) cursor.
    const overlayChild = el({ x: 0, y: 0, w: 800, h: 600, styles: { pointerEvents: "none" } });
    const overlay = el({
      x: 0, y: 0, w: 800, h: 600,
      styles: { position: "absolute", zIndex: "10", pointerEvents: "none" },
      children: [overlayChild],
    });
    const link = el({ x: 100, y: 100, w: 200, h: 40, cursor: "pointer" });
    const body = el({ x: 0, y: 0, w: 800, h: 600, children: [link, overlay] });
    expect(cursorAtPoint([body], 150, 120)).toBe("pointer");
  });

  it("overflow:hidden clips descendants' hit boxes to the scroller", () => {
    // A child extending past its overflow:hidden parent isn't hittable
    // outside the clip (matching browser hit-testing of clipped content).
    const wide = el({ x: 0, y: 0, w: 900, h: 50, cursor: "pointer" });
    const scroller = el({ x: 0, y: 0, w: 300, h: 50, styles: { overflowX: "hidden", overflowY: "hidden" }, children: [wide] });
    const body = el({ x: 0, y: 0, w: 1000, h: 500, cursor: "text", children: [scroller] });
    expect(cursorAtPoint([body], 100, 25)).toBe("pointer"); // inside the clip
    expect(cursorAtPoint([body], 600, 25)).toBe("text");    // clipped away → the body answers
  });

  it("position:fixed escapes ancestor overflow clips", () => {
    const pin = el({ x: 900, y: 400, w: 60, h: 60, cursor: "pointer", styles: { position: "fixed" } });
    const scroller = el({ x: 0, y: 0, w: 300, h: 100, styles: { overflowX: "hidden", overflowY: "hidden" }, children: [pin] });
    const body = el({ x: 0, y: 0, w: 1000, h: 500, cursor: "text", children: [scroller] });
    expect(cursorAtPoint([body], 920, 420)).toBe("pointer"); // outside the scroller box, still hit
  });
});

describe("hitTestTopmost: basics", () => {
  it("returns null / default outside everything and for empty trees", () => {
    expect(hitTestTopmost([], 10, 10)).toBeNull();
    const body = el({ x: 0, y: 0, w: 100, h: 100 });
    expect(hitTestTopmost([body], 500, 500)).toBeNull();
    expect(cursorAtPoint([body], 500, 500)).toBe("default");
  });

  it("ignores zero-size boxes", () => {
    const empty = el({ x: 0, y: 0, w: 0, h: 0, cursor: "pointer" });
    const body = el({ x: 0, y: 0, w: 100, h: 100, cursor: "text", children: [empty] });
    expect(cursorAtPoint([body], 0, 0)).toBe("text");
  });

  it("tolerates hand-built trees without styles/children (public-API robustness)", () => {
    const bare = { tag: "div", text: "", x: 0, y: 0, width: 100, height: 100, cursor: "pointer" } as unknown as CapturedElement;
    expect(cursorAtPoint([bare], 50, 50)).toBe("pointer");
  });
});
