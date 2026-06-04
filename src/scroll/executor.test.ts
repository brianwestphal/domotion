import { describe, expect, it } from "vitest";

import {
  __walkPatternForTest,
  axisOfScroll,
  resolveAbsoluteTarget,
  resolveScrollAction,
  type PageQuery,
  type PageStateSnapshot,
} from "./executor.js";
import { parseScrollPattern } from "./pattern.js";
import type { ScrollAction, AbsoluteTarget } from "./pattern.js";

// ── Fake PageQuery for the pure helpers' tests ─────────────────────────────

function fakePageQuery(opts: Partial<PageStateSnapshot> = {}, selectors: Record<string, { x: number; y: number; width?: number; height?: number }> = {}): { query: PageQuery; snap: PageStateSnapshot } {
  const snap: PageStateSnapshot = {
    maxScrollX: opts.maxScrollX ?? 0,
    maxScrollY: opts.maxScrollY ?? 4000,
    scrollX: opts.scrollX ?? 0,
    scrollY: opts.scrollY ?? 0,
  };
  const query: PageQuery = {
    async snapshot() { return { ...snap }; },
    async selectorBbox(css) {
      const r = selectors[css];
      if (r == null) return null;
      return { x: r.x, y: r.y, width: r.width ?? 100, height: r.height ?? 20 };
    },
  };
  return { query, snap };
}

// ── axisOfScroll ────────────────────────────────────────────────────────────

describe("axisOfScroll", () => {
  it("direction prefix wins", () => {
    expect(axisOfScroll({ kind: "scroll", direction: "up",    target: { kind: "delta", signedLength: { sign: 1, value: 100, unit: "px" } } } as ScrollAction)).toBe("y");
    expect(axisOfScroll({ kind: "scroll", direction: "down",  target: { kind: "delta", signedLength: { sign: 1, value: 100, unit: "px" } } } as ScrollAction)).toBe("y");
    expect(axisOfScroll({ kind: "scroll", direction: "left",  target: { kind: "delta", signedLength: { sign: 1, value: 100, unit: "px" } } } as ScrollAction)).toBe("x");
    expect(axisOfScroll({ kind: "scroll", direction: "right", target: { kind: "delta", signedLength: { sign: 1, value: 100, unit: "px" } } } as ScrollAction)).toBe("x");
  });

  it("anchor type implies axis when no direction", () => {
    const bottomAction: ScrollAction = {
      kind: "scroll",
      target: { kind: "absolute", anchor: { kind: "named", name: "bottom" }, offsets: [] },
    };
    expect(axisOfScroll(bottomAction)).toBe("y");
    const rightAction: ScrollAction = {
      kind: "scroll",
      target: { kind: "absolute", anchor: { kind: "named", name: "right" }, offsets: [] },
    };
    expect(axisOfScroll(rightAction)).toBe("x");
  });

  it("axis suffix .x switches to x", () => {
    const a: ScrollAction = {
      kind: "scroll",
      target: { kind: "absolute", anchor: { kind: "named", name: "start" }, axisSuffix: "x", offsets: [] },
    };
    expect(axisOfScroll(a)).toBe("x");
  });

  it("defaults to y for bare deltas", () => {
    const a: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: 1, value: 100, unit: "px" } },
    };
    expect(axisOfScroll(a)).toBe("y");
  });
});

// ── resolveAbsoluteTarget ──────────────────────────────────────────────────

describe("resolveAbsoluteTarget", () => {
  it("named anchor `top` is 0", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const target: AbsoluteTarget = { kind: "absolute", anchor: { kind: "named", name: "top" }, offsets: [] };
    expect(await resolveAbsoluteTarget(target, "y", query, snap)).toBe(0);
  });

  it("named anchor `bottom` is maxScrollY", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const target: AbsoluteTarget = { kind: "absolute", anchor: { kind: "named", name: "bottom" }, offsets: [] };
    expect(await resolveAbsoluteTarget(target, "y", query, snap)).toBe(4000);
  });

  it("anchor + arithmetic", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const target: AbsoluteTarget = {
      kind: "absolute",
      anchor: { kind: "named", name: "top" },
      offsets: [{ op: "+", length: { value: 200, unit: "px" } }],
    };
    expect(await resolveAbsoluteTarget(target, "y", query, snap)).toBe(200);
  });

  it("anchor - arithmetic", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const target: AbsoluteTarget = {
      kind: "absolute",
      anchor: { kind: "named", name: "bottom" },
      offsets: [{ op: "-", length: { value: 1000, unit: "px" } }],
    };
    expect(await resolveAbsoluteTarget(target, "y", query, snap)).toBe(3000);
  });

  it("percent operand scales against maxScroll on axis", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const target: AbsoluteTarget = {
      kind: "absolute",
      anchor: { kind: "named", name: "top" },
      offsets: [{ op: "+", length: { value: 25, unit: "%" } }],
    };
    expect(await resolveAbsoluteTarget(target, "y", query, snap)).toBe(1000);
  });

  it("selector resolves via PageQuery", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 }, { ".footer": { x: 0, y: 3500 } });
    const target: AbsoluteTarget = {
      kind: "absolute",
      anchor: { kind: "selector", cssSelector: ".footer" },
      offsets: [{ op: "-", length: { value: 200, unit: "px" } }],
    };
    expect(await resolveAbsoluteTarget(target, "y", query, snap)).toBe(3300);
  });

  it("selector with axis suffix .x uses bbox x", async () => {
    const { query, snap } = fakePageQuery({ maxScrollX: 2000, maxScrollY: 4000 }, { ".panel": { x: 500, y: 100 } });
    const target: AbsoluteTarget = {
      kind: "absolute",
      anchor: { kind: "selector", cssSelector: ".panel" },
      axisSuffix: "x",
      offsets: [{ op: "+", length: { value: 200, unit: "px" } }],
    };
    expect(await resolveAbsoluteTarget(target, "x", query, snap)).toBe(700);
  });

  it("selector not found throws", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const target: AbsoluteTarget = {
      kind: "absolute",
      anchor: { kind: "selector", cssSelector: ".missing" },
      offsets: [],
    };
    await expect(resolveAbsoluteTarget(target, "y", query, snap)).rejects.toThrow();
  });
});

// ── resolveScrollAction ────────────────────────────────────────────────────

describe("resolveScrollAction", () => {
  it("bare 720px from y=0 → destY=720, default speed picks duration", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const action: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: 1, value: 720, unit: "px" } },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.axis).toBe("y");
    expect(r.destY).toBe(720);
    expect(r.destX).toBe(0);
    // 720 / 1500 * 1000 = 480
    expect(r.scrollDurationMs).toBe(480);
  });

  it("explicit /<duration> overrides default speed", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const action: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: 1, value: 720, unit: "px" } },
      durationMs: 3000,
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.scrollDurationMs).toBe(3000);
  });

  it("explicit @<speed> overrides the executor's default speed", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000 });
    const action: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: 1, value: 720, unit: "px" } },
      speedPxPerSec: 600,
    };
    // 720 / 600 * 1000 = 1200. Default speed of 1500 is ignored.
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.scrollDurationMs).toBe(1200);
  });

  it("@<speed> applies to the actual scroll magnitude, not the requested delta", async () => {
    // Scroll request of 5000 px but page maxScrollY=4000 — actual magnitude
    // is 4000 px after clamping. Speed math uses the clamped magnitude so
    // the action lands at the boundary in the right amount of time.
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 0 });
    const action: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: 1, value: 5000, unit: "px" } },
      speedPxPerSec: 1000,
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(4000);
    expect(r.scrollDurationMs).toBe(4000);
  });

  it("`down:-100px` reverses direction (same as up:100px)", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 500 });
    const action: ScrollAction = {
      kind: "scroll",
      direction: "down",
      target: { kind: "delta", signedLength: { sign: -1, value: 100, unit: "px" } },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(400);   // 500 + (1 * -100) = 400
  });

  it("`up:100px` from y=500 → destY=400", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 500 });
    const action: ScrollAction = {
      kind: "scroll",
      direction: "up",
      target: { kind: "delta", signedLength: { sign: 1, value: 100, unit: "px" } },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(400);
  });

  it("delta clamped to bottom", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 3800 });
    const action: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: 1, value: 500, unit: "px" } },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(4000);   // clamped
  });

  it("delta clamped to top (not negative)", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 100 });
    const action: ScrollAction = {
      kind: "scroll",
      target: { kind: "delta", signedLength: { sign: -1, value: 500, unit: "px" } },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(0);
  });

  it("absolute target `top + 200px` from y=500 → destY=200", async () => {
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 500 });
    const action: ScrollAction = {
      kind: "scroll",
      direction: "up",
      target: { kind: "absolute", anchor: { kind: "named", name: "top" }, offsets: [{ op: "+", length: { value: 200, unit: "px" } }] },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(200);
  });

  it("direction conflict clamps to no-op", async () => {
    // `up:bottom` from y=0 — natural delta is positive (down to bottom), but
    // direction prefix says up. Cross-direction conflict → no-op.
    const { query, snap } = fakePageQuery({ maxScrollY: 4000, scrollY: 0 });
    const action: ScrollAction = {
      kind: "scroll",
      direction: "up",
      target: { kind: "absolute", anchor: { kind: "named", name: "bottom" }, offsets: [] },
    };
    const r = await resolveScrollAction(action, query, snap, 1500);
    expect(r.destY).toBe(0);
    expect(r.scrollDurationMs).toBe(0);
  });
});

// ── until <position>: final-iteration target clamp (DM-1077) ────────────────

describe("until <position> final-iteration clamp", () => {
  // Stateful fake page: scrollY advances as each scroll op runs (the op's dest
  // becomes the new position), and snapshot() reflects it — so the until loop
  // makes real progress and re-resolves the condition each iteration.
  function statefulPage(maxScrollY: number): { query: PageQuery; state: PageStateSnapshot; destYs: number[] } {
    const state: PageStateSnapshot = { maxScrollX: 0, maxScrollY, scrollX: 0, scrollY: 0 };
    const destYs: number[] = [];
    const query: PageQuery = {
      async snapshot() { return { ...state }; },
      async selectorBbox() { return null; },
    };
    return { query, state, destYs };
  }

  it("`until bottom - 1000px` lands exactly on the target, not one step past", async () => {
    // maxScrollY 4000 → `bottom - 1000px` resolves to y = 3000. 700px steps from
    // 0 reach 700/1400/2100/2800; the next step would hit 3500 (past 3000), so
    // the clamp caps the final destination at exactly 3000. Without the clamp
    // the loop would land at 3500 — one action-magnitude past the target.
    const { query, state, destYs } = statefulPage(4000);
    await __walkPatternForTest(
      parseScrollPattern("down:700px until bottom - 1000px"),
      query, 1000,
      async (op) => {
        if (op.kind === "scroll") { state.scrollX = op.destX; state.scrollY = op.destY; destYs.push(op.destY); }
      },
      () => { /* no timeout */ },
      () => { /* silent log */ },
    );
    expect(destYs).toEqual([700, 1400, 2100, 2800, 3000]);
    expect(state.scrollY).toBe(3000);
  });

  it("a step that divides the target evenly is unaffected (no spurious clamp)", async () => {
    // 600px steps from 0 hit the 3000 target exactly on the fifth step, so the
    // clamp is a no-op and every destination is a clean multiple of 600.
    const { query, state, destYs } = statefulPage(4000);
    await __walkPatternForTest(
      parseScrollPattern("down:600px until bottom - 1000px"),
      query, 1000,
      async (op) => {
        if (op.kind === "scroll") { state.scrollX = op.destX; state.scrollY = op.destY; destYs.push(op.destY); }
      },
      () => {},
      () => {},
    );
    expect(destYs).toEqual([600, 1200, 1800, 2400, 3000]);
    expect(state.scrollY).toBe(3000);
  });
});
