/**
 * Unit tests for the `animate` config schema + vars interpolation
 * (src/cli/animate.ts). Pure / no Chromium — the action *execution* and the
 * continuous-session capture are exercised by the integration harness, but the
 * schema rules and `${}` substitution are deterministic and testable here.
 */

import { describe, it, expect } from "vitest";
import { validateAnimateConfig, interpolateConfigVars, buildCursorOverlay, type AnimateConfig } from "./animate.js";
import type { CursorEvent } from "../index.js";

const base = { width: 100, height: 100 };

/** Mirror composeAnimateConfig's per-frame start-time accumulation. */
function frameStartsFor(frames: AnimateConfig["frames"]): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const f of frames) {
    starts.push(acc);
    acc += f.duration + (f.transition == null ? 300 : f.transition.type === "cut" ? 0 : f.transition.duration);
  }
  return starts;
}
const clicksOf = (ov: ReturnType<typeof buildCursorOverlay>): CursorEvent[] =>
  (ov?.events ?? []).filter((e) => e.type === "click");

describe("validateAnimateConfig — declarative config (DM-846/847/848/852/853)", () => {
  it("accepts the new DOM-mutation / interaction / evaluate actions", () => {
    const cfg = validateAnimateConfig({
      ...base,
      frames: [
        {
          input: "a.html",
          duration: 100,
          actions: [
            { type: "setText", selector: "#x", value: "hi" },
            { type: "setStyle", selector: "#x", props: { display: "none" } },
            { type: "insert", selector: "#x", position: "beforeend", html: "<b>z</b>" },
            { type: "replaceText", selector: "#x", pattern: "^/Users/[^/]+/", replacement: "~/", flags: "g" },
            { type: "scrollIntoView", selector: "#x", block: "center" },
            { type: "dispatch", selector: "#x", event: "input" },
            { type: "evaluate", script: "void 0" },
          ],
        },
      ],
    });
    expect(cfg.frames[0].actions).toHaveLength(7);
  });

  it("rejects a replaceText with an invalid regex pattern", () => {
    expect(() =>
      validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, actions: [{ type: "replaceText", selector: "#x", pattern: "(", replacement: "" }] }],
      }),
    ).toThrow(/not a valid regular expression/);
  });

  describe("continuous-session rules (DM-846)", () => {
    it("allows a later frame to omit input (implicit continue)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1 }, { duration: 1 }],
      });
      expect(cfg.frames[1].input).toBeUndefined();
    });

    it("allows continue: true on a later frame", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1 }, { continue: true, duration: 1 }],
      });
      expect(cfg.frames[1].continue).toBe(true);
    });

    it("errors when frame 0 has no input", () => {
      expect(() => validateAnimateConfig({ ...base, frames: [{ duration: 1 }] })).toThrow(/frame 0 must load an .input., a .cast., or a .template./);
    });

    it("errors when frame 0 sets continue", () => {
      expect(() => validateAnimateConfig({ ...base, frames: [{ input: "a.html", continue: true, duration: 1 }] })).toThrow(/frame 0 cannot continue/);
    });

    it("errors when a frame sets both continue and input", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1 }, { continue: true, input: "b.html", duration: 1 }] }),
      ).toThrow(/cannot set both `continue` and `input`/);
    });
  });

  describe("terminal `cast` frames (DM-1225)", () => {
    it("accepts a cast frame at index 0 with term options", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ cast: "./session.cast", term: { theme: "dark", maxFrameMs: 700, fontSize: 13 }, duration: 8000 }],
      });
      expect(cfg.frames[0].cast).toBe("./session.cast");
      expect(cfg.frames[0].term?.theme).toBe("dark");
      expect(cfg.frames[0].term?.maxFrameMs).toBe(700);
    });

    it("composes a cast frame alongside html frames", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [
          { input: "intro.html", duration: 1500, transition: { type: "crossfade", duration: 300 } },
          { cast: "build.cast", duration: 9000 },
        ],
      });
      expect(cfg.frames).toHaveLength(2);
      expect(cfg.frames[1].cast).toBe("build.cast");
    });

    it("rejects a frame that sets both cast and input", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ cast: "x.cast", input: "y.html", duration: 1 }] }),
      ).toThrow(/cannot set both `cast` and `input`/);
    });

    it("rejects a cast frame that also continues a live page", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1 }, { cast: "x.cast", continue: true, duration: 1 }] }),
      ).toThrow(/`cast` frame cannot also `continue`/);
    });
  });

  describe("template frames (DM-1287)", () => {
    it("accepts a template frame at index 0 with params", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ template: "lower-third", params: { title: "Ada" }, duration: 3000 }],
      });
      expect(cfg.frames[0].template).toBe("lower-third");
      expect(cfg.frames[0].params).toEqual({ title: "Ada" });
    });

    it("composes a template frame alongside html frames", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [
          { input: "intro.html", duration: 1500, transition: { type: "crossfade", duration: 300 } },
          { template: "lower-third", params: { title: "Ada" }, duration: 3000 },
        ],
      });
      expect(cfg.frames).toHaveLength(2);
      expect(cfg.frames[1].template).toBe("lower-third");
    });

    it("rejects a frame that sets both template and input", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ template: "lower-third", input: "y.html", duration: 1 }] }),
      ).toThrow(/cannot set both `template` and `input`/);
    });

    it("rejects a frame that sets both template and cast", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ template: "lower-third", cast: "x.cast", duration: 1 }] }),
      ).toThrow(/cannot set both `template` and `cast`/);
    });

    it("rejects a template frame that also continues a live page", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1 }, { template: "lower-third", continue: true, duration: 1 }] }),
      ).toThrow(/`template` frame cannot also `continue`/);
    });

    it("rejects `params` without a `template`", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", params: { title: "x" }, duration: 1 }] }),
      ).toThrow(/`params` requires a `template`/);
    });
  });

  it("accepts a top-level vars map", () => {
    const cfg = validateAnimateConfig({ ...base, vars: { base: "http://x" }, frames: [{ input: "${base}", duration: 1 }] });
    expect(cfg.vars).toEqual({ base: "http://x" });
  });

  describe("readiness waits (DM-849)", () => {
    it("accepts waitForText / waitForGone / waitForCount", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [
          {
            input: "a.html",
            duration: 1,
            waitForText: { selector: ".count", equals: "1" },
            waitForGone: ".spinner",
            waitForCount: { selector: ".item", atLeast: 1 },
          },
        ],
      });
      expect(cfg.frames[0].waitForText?.equals).toBe("1");
      expect(cfg.frames[0].waitForGone).toBe(".spinner");
      expect(cfg.frames[0].waitForCount?.atLeast).toBe(1);
    });

    it("rejects waitForText with neither equals nor contains", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, waitForText: { selector: ".x" } }] }),
      ).toThrow(/requires `equals` or `contains`/);
    });

    it("rejects waitForCount with no equals/atLeast/atMost", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, waitForCount: { selector: ".x" } }] }),
      ).toThrow(/requires `equals`, `atLeast`, or `atMost`/);
    });
  });

  describe("repeating animations (DM-869)", () => {
    it("accepts repeat (integer | \"infinite\") + alternate on a frame animation", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, animations: [
          { selector: ".caret", property: "opacity", from: "1", to: "0", duration: 530, repeat: "infinite", alternate: true },
        ] }],
      });
      const a = cfg.frames[0].animations?.[0];
      expect(a?.repeat).toBe("infinite");
      expect(a?.alternate).toBe(true);
    });

    it("rejects a non-positive repeat count", () => {
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, animations: [
            { selector: ".c", property: "opacity", from: "1", to: "0", duration: 1, repeat: 0 },
          ] }],
        }),
      ).toThrow();
    });

    it("DM-870: accepts a typing-overlay caret (boolean or object)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, overlays: [
          { kind: "typing", text: "hi", x: 1, y: 2, caret: true },
          { kind: "typing", text: "yo", x: 1, y: 20, caret: { color: "#fff", width: 2, blinkMs: 500 } },
        ] }],
      });
      expect(cfg.frames[0].overlays).toHaveLength(2);
    });

    it("DM-871: accepts a blink overlay", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, overlays: [
          { kind: "blink", x: 1, y: 2, width: 10, height: 10, periodMs: 800, color: "#ef4444", radius: 5 },
        ] }],
      });
      expect(cfg.frames[0].overlays?.[0]).toMatchObject({ kind: "blink" });
    });

    it("DM-861: accepts overlay anchor + maxWidth; x/y default to 0 when omitted", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, overlays: [
          { kind: "typing", text: "hi", anchor: { selector: ".f", at: "top-left", dx: 8, dy: 8 }, maxWidth: "anchor" },
          { kind: "blink", width: 4, height: 12, anchor: { selector: ".c" } },
        ] }],
      });
      expect(cfg.frames[0].overlays).toHaveLength(2);
      // x/y default to 0 when omitted (the anchor overrides them at capture time).
      expect(cfg.frames[0].overlays?.[0]).toMatchObject({ kind: "typing", x: 0, y: 0 });
    });
  });
});

describe("interpolateConfigVars (DM-852)", () => {
  it("substitutes ${name} across nested string fields", () => {
    const out = interpolateConfigVars({
      ...base,
      vars: { base: "http://localhost:4188", file: "session.ts" },
      frames: [{ input: "${base}", duration: 1, actions: [{ type: "click", selector: ".f[title='${file}']" }] }],
    });
    expect(out.frames[0].input).toBe("http://localhost:4188");
    const action = out.frames[0].actions?.[0];
    expect(action != null && "selector" in action ? action.selector : undefined).toBe(".f[title='session.ts']");
  });

  it("throws on an unknown variable", () => {
    expect(() =>
      interpolateConfigVars({ ...base, vars: { a: "1" }, frames: [{ input: "${nope}", duration: 1 }] }),
    ).toThrow(/unknown variable \$\{nope\}/);
  });

  it("escapes $${ to a literal ${", () => {
    const out = interpolateConfigVars({ ...base, vars: { a: "1" }, frames: [{ input: "$${a}", duration: 1 }] });
    expect(out.frames[0].input).toBe("${a}");
  });

  it("is a no-op when there are no vars", () => {
    const cfg = { ...base, frames: [{ input: "${a}", duration: 1 }] };
    expect(interpolateConfigVars(cfg)).toBe(cfg);
  });
});

describe("cursor overlay config (DM-851)", () => {
  const base = { width: 100, height: 100 };

  it("accepts cursor: \"auto\"", () => {
    const cfg = validateAnimateConfig({ ...base, cursor: "auto", frames: [{ input: "a.html", duration: 1, actions: [{ type: "click", selector: ".b" }] }] });
    expect(cfg.cursor).toBe("auto");
  });

  it("accepts explicit cursor events", () => {
    const cfg = validateAnimateConfig({
      ...base,
      cursor: { style: { scale: 1.5 }, events: [{ frame: 0, at: 100, type: "moveClick", selector: ".b" }] },
      frames: [{ input: "a.html", duration: 1 }],
    });
    expect(typeof cfg.cursor === "object" && cfg.cursor.events).toHaveLength(1);
  });

  it("rejects a move event without selector or to", () => {
    expect(() =>
      validateAnimateConfig({ ...base, cursor: { events: [{ frame: 0, type: "move" }] }, frames: [{ input: "a.html", duration: 1 }] }),
    ).toThrow(/requires `selector` or `to`/);
  });
});

// DM-1050: auto-cursor click TIMING. In the continuous-session model a frame's
// content is the RESULT of its actions (capture runs after the actions), and the
// transition INTO that frame reveals the result. So a click captured into a
// `continue` frame must be shown over the PREVIOUS frame's "before" image,
// landing just before the transition — not in the middle of the frame that
// already shows the change it caused. Before this fix, the cart-htmx demo's
// three clicks fired at 1850 / 3170 / 4590 ms — each ~550 ms AFTER its own
// result was already on screen.
describe("buildCursorOverlay: auto click timing (DM-1050)", () => {
  // The cart-htmx shape: an initial frame then three continue frames, each one
  // click + a 220 ms crossfade. (durations: 1000, 1100, 1100, 1300.)
  const frames = validateAnimateConfig({
    ...base,
    cursor: "auto",
    frames: [
      { input: "a.html", duration: 1000 },
      { continue: true, duration: 1100, transition: { type: "crossfade", duration: 220 }, actions: [{ type: "click", selector: "#load" }] },
      { continue: true, duration: 1100, transition: { type: "crossfade", duration: 220 }, actions: [{ type: "click", selector: "#remove" }] },
      { continue: true, duration: 1300, transition: { type: "crossfade", duration: 220 }, actions: [{ type: "click", selector: "#reload" }] },
    ],
  }).frames;
  const starts = frameStartsFor(frames); // [0, 1300, 2620, 3940]
  // One auto target per click, recorded against the frame whose actions hold it.
  const targets = [
    { frame: 1, cx: 10, cy: 10 },
    { frame: 2, cx: 20, cy: 20 },
    { frame: 3, cx: 30, cy: 30 },
  ];

  it("fires each continue-frame's click during the PREVIOUS frame's hold, before the reveal", () => {
    const ov = buildCursorOverlay(true, [], undefined, targets, new Map(), starts, frames);
    const clickTimes = clicksOf(ov).map((c) => c.t).sort((a, b) => a - b);
    expect(clickTimes).toHaveLength(3);
    // Each click must land within its STAGE frame's hold (the before-image) and
    // strictly before the result frame's own start (= when its reveal completes).
    for (let i = 0; i < 3; i++) {
      const actionFrame = i + 1;
      const stage = actionFrame - 1; // continue frames stage over the predecessor
      const stageStart = starts[stage];
      const stageHoldEnd = starts[stage] + frames[stage].duration;
      const t = clickTimes[i];
      expect(t).toBeGreaterThanOrEqual(stageStart);
      expect(t).toBeLessThanOrEqual(stageHoldEnd);          // within the before-image's hold
      expect(t).toBeLessThan(starts[actionFrame]);          // before the result frame begins
    }
  });

  it("does NOT fire a click during its OWN result frame's hold (the bug)", () => {
    const ov = buildCursorOverlay(true, [], undefined, targets, new Map(), starts, frames);
    const clickTimes = clicksOf(ov).map((c) => c.t).sort((a, b) => a - b);
    // The old behavior placed each click at the mid-hold of the frame that holds
    // its action — i.e. inside the result image (1850 / 3170 / 4590). Each
    // click[i] is for action frame i+1; assert it is NOT inside that frame's hold.
    for (let i = 0; i < 3; i++) {
      const actionFrame = i + 1;
      const holdStart = starts[actionFrame];
      const holdEnd = starts[actionFrame] + frames[actionFrame].duration;
      const t = clickTimes[i];
      expect(t < holdStart || t > holdEnd).toBe(true);
    }
    // And concretely: none of the new times equal the old buggy mid-hold times.
    expect(clickTimes).not.toContain(1850);
    expect(clickTimes).not.toContain(3170);
    expect(clickTimes).not.toContain(4590);
  });

  it("keeps a frame-0 / reload-frame click in its own hold (no prior before-image to stage over)", () => {
    const reloadFrames = validateAnimateConfig({
      ...base,
      cursor: "auto",
      frames: [
        { input: "a.html", duration: 1000, actions: [{ type: "click", selector: "#a" }] },
        { input: "b.html", duration: 1000, transition: { type: "crossfade", duration: 200 }, actions: [{ type: "click", selector: "#b" }] },
      ],
    }).frames;
    const rs = frameStartsFor(reloadFrames); // [0, 1300]
    const rt = [{ frame: 0, cx: 1, cy: 1 }, { frame: 1, cx: 2, cy: 2 }];
    const ov = buildCursorOverlay(true, [], undefined, rt, new Map(), rs, reloadFrames);
    const ct = clicksOf(ov).map((c) => c.t).sort((a, b) => a - b);
    expect(ct).toHaveLength(2);
    // Frame 0 click stays in frame 0's hold; the reload frame's click stays in
    // its OWN hold (its before-state was never captured, so there's nothing to
    // stage it over).
    expect(ct[0]).toBeGreaterThanOrEqual(rs[0]);
    expect(ct[0]).toBeLessThanOrEqual(rs[0] + reloadFrames[0].duration);
    expect(ct[1]).toBeGreaterThanOrEqual(rs[1]);
    expect(ct[1]).toBeLessThanOrEqual(rs[1] + reloadFrames[1].duration);
  });
});
