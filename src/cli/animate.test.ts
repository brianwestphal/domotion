/**
 * Unit tests for the `animate` config schema + vars interpolation
 * (src/cli/animate.ts). Pure / no Chromium — the action *execution* and the
 * continuous-session capture are exercised by the integration harness, but the
 * schema rules and `${}` substitution are deterministic and testable here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateAnimateConfig, interpolateConfigVars, resolveConfigBrand, buildCursorOverlay, placeEmbeddedFrame, resolveEmbeddedFrameOverlays, configTextTrackSpec, type AnimateConfig } from "./animate.js";
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

    // DM-1294: a template frame may omit `duration` (derived from the template's
    // play time at compose time); every other frame must set a positive one.
    it("accepts a template frame that omits `duration`", () => {
      const cfg = validateAnimateConfig({ ...base, frames: [{ template: "lower-third", params: { title: "Ada" } }] });
      expect(cfg.frames[0].duration).toBe(0); // 0 = the "derive at compose time" sentinel
    });

    it("rejects a non-template frame that omits `duration`", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html" }] }),
      ).toThrow(/`duration` is required and must be > 0/);
    });

    it("rejects a non-template frame with a non-positive `duration`", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 0 }] }),
      ).toThrow(/`duration` is required and must be > 0/);
    });

    // DM-1293: per-frame `fit` placement policy (template frames only).
    it("accepts a template frame with a `fit` policy", () => {
      const cfg = validateAnimateConfig({ ...base, frames: [{ template: "lower-third", params: { title: "Ada" }, duration: 1, fit: "contain" }] });
      expect(cfg.frames[0].fit).toBe("contain");
    });

    it("rejects an invalid `fit` value", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ template: "lower-third", duration: 1, fit: "stretch" }] }),
      ).toThrow();
    });

    it("rejects `fit` without a `template`", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, fit: "contain" }] }),
      ).toThrow(/`fit` requires a `template`/);
    });
  });

  // DM-1556 (docs/93 §2): per-keystroke real-site re-sampling.
  describe("typeResample frames (DM-1556)", () => {
    it("accepts a typeResample frame with just selector/text (defaults applied at run time)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "form.html", duration: 2000, typeResample: { selector: "#phone", text: "4155550142" } }],
      });
      expect(cfg.frames[0].typeResample).toEqual({ selector: "#phone", text: "4155550142" });
    });

    it("accepts a typeResample frame on a continue frame (it drives the live page)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [
          { input: "form.html", duration: 1 },
          { continue: true, duration: 2000, typeResample: { selector: "#phone", text: "42", speed: 40, delay: 100, tailMs: 300, clear: false, caret: false } },
        ],
      });
      expect(cfg.frames[1].typeResample?.clear).toBe(false);
    });

    it("rejects an empty typeResample text", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "form.html", duration: 1, typeResample: { selector: "#p", text: "" } }] }),
      ).toThrow(/must be a non-empty string/);
    });

    it("rejects typeResample combined with scroll", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, typeResample: { selector: "#p", text: "x" }, scroll: { pattern: "down" } }] }),
      ).toThrow(/cannot set both `typeResample` and `scroll`/);
    });

    it("rejects typeResample combined with cast", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ cast: "x.cast", duration: 1, typeResample: { selector: "#p", text: "x" } }] }),
      ).toThrow(/cannot set both `typeResample` and `cast`/);
    });

    it("rejects typeResample combined with template", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ template: "lower-third", duration: 1, typeResample: { selector: "#p", text: "x" } }] }),
      ).toThrow(/cannot set both `typeResample` and `template`/);
    });
  });

  // DM-1564 (docs/94 option 3): MutationObserver JS-change harness.
  describe("jsReveal frames (DM-1564)", () => {
    it("accepts a jsReveal frame with just a selector (defaults applied at run time)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "menu.html", duration: 2000, jsReveal: { selector: "#account" } }],
      });
      expect(cfg.frames[0].jsReveal).toEqual({ selector: "#account" });
    });

    it("accepts an explicit event + timing", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "menu.html", duration: 2000, jsReveal: { selector: "#a", event: "mousedown", settleMs: 400, debounceMs: 80, holdMs: 600, crossfadeMs: 0 } }],
      });
      expect(cfg.frames[0].jsReveal?.event).toBe("mousedown");
    });

    it("rejects an unsupported jsReveal event", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "menu.html", duration: 1, jsReveal: { selector: "#a", event: "keydown" } }] }),
      ).toThrow();
    });

    it("rejects jsReveal combined with scroll / cast / template / typeResample", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, jsReveal: { selector: "#a" }, scroll: { pattern: "down" } }] }),
      ).toThrow(/cannot set both `jsReveal` and `scroll`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ cast: "x.cast", duration: 1, jsReveal: { selector: "#a" } }] }),
      ).toThrow(/cannot set both `jsReveal` and `cast`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ template: "lower-third", duration: 1, jsReveal: { selector: "#a" } }] }),
      ).toThrow(/cannot set both `jsReveal` and `template`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, jsReveal: { selector: "#a" }, typeResample: { selector: "#p", text: "x" } }] }),
      ).toThrow(/cannot set both `jsReveal` and `typeResample`/);
    });
  });

  describe("compressed-run `states` frames (DM-1747, docs/100 Primitive 1)", () => {
    it("accepts a states frame with per-state actions and an auto-caret", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{
          input: "editor.html",
          duration: 1500,
          caret: true,
          states: [
            { duration: 200 },
            { actions: [{ type: "evaluate", script: "ins(1)" }], duration: 170 },
            { actions: [{ type: "setText", selector: "#l1", value: "done" }], duration: 900 },
          ],
        }],
      });
      expect(cfg.frames[0].states).toHaveLength(3);
      expect(cfg.frames[0].caret).toBe(true);
    });

    it("accepts caret as a { shape, color } object; rejects a bad shape", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, states: [{ duration: 100 }], caret: { shape: "block", color: "#ff0000" } }],
      });
      expect(cfg.frames[0].caret).toEqual({ shape: "block", color: "#ff0000" });
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, states: [{ duration: 100 }], caret: { shape: "beam" } }] }),
      ).toThrow(/caret/);
    });

    it("rejects an empty states array (path-specific)", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, states: [] }] }),
      ).toThrow(/frames\[0\]\.states: must be a non-empty array/);
    });

    it("rejects a non-positive state duration (path-specific)", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, states: [{ duration: 0 }] }] }),
      ).toThrow(/frames\[0\]\.states\[0\]\.duration: must be a positive number \(ms\)/);
    });

    it("rejects states combined with scroll / cast / template / typeResample / jsReveal", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, states: [{ duration: 100 }], scroll: { pattern: "down" } }] }),
      ).toThrow(/cannot set both `states` and `scroll`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ cast: "x.cast", duration: 1, states: [{ duration: 100 }] }] }),
      ).toThrow(/cannot set both `states` and `cast`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ template: "lower-third", duration: 1, states: [{ duration: 100 }] }] }),
      ).toThrow(/cannot set both `states` and `template`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, states: [{ duration: 100 }], typeResample: { selector: "#p", text: "x" } }] }),
      ).toThrow(/cannot set both `states` and `typeResample`/);
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, states: [{ duration: 100 }], jsReveal: { selector: "#a" } }] }),
      ).toThrow(/cannot set both `states` and `jsReveal`/);
    });

    it("rejects `caret` without `states`", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, caret: true }] }),
      ).toThrow(/frames\[0\]\.caret: `caret` requires a `states` compressed run/);
    });

    it("allows states on a continue frame (it drives the live page)", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1 }, { continue: true, duration: 1, states: [{ duration: 100 }] }],
      });
      expect(cfg.frames[1].states).toHaveLength(1);
    });
  });

  describe("caret/selection `textTracks` frames (DM-1747, docs/101)", () => {
    it("accepts a track with the full event vocabulary + options", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{
          input: "a.html",
          duration: 4000,
          textTracks: [{
            selector: "#line",
            shape: "block",
            color: "#ff0000",
            barWidthPx: 1.5,
            blinkMs: 900,
            selectionColor: "#22ff2288",
            events: [
              { type: "park", at: 200, charOffset: 0 },
              { type: "move", at: 1200, charOffset: 6, selector: "#other" },
              { type: "select", at: 2000, charStart: 0, charEnd: 5, sweepMs: 600, color: "#0000ff44" },
              { type: "clearSelection", at: 3000 },
              { type: "hide", at: 3500 },
            ],
          }],
        }],
      });
      expect(cfg.frames[0].textTracks?.[0].events).toHaveLength(5);
    });

    it("rejects an empty events array (path-specific)", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, textTracks: [{ selector: "#x", events: [] }] }] }),
      ).toThrow(/frames\[0\]\.textTracks\[0\]\.events: must be a non-empty array/);
    });

    it("rejects a select whose charEnd <= charStart (path-specific)", () => {
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, textTracks: [{ selector: "#x", events: [{ type: "select", at: 0, charStart: 5, charEnd: 5 }] }] }],
        }),
      ).toThrow(/frames\[0\]\.textTracks\[0\]\.events\[0\]\.charEnd: `charEnd` must be greater than `charStart`/);
    });

    it("rejects a negative event time and a negative charOffset", () => {
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, textTracks: [{ selector: "#x", events: [{ type: "park", at: -1, charOffset: 0 }] }] }],
        }),
      ).toThrow(/frames\[0\]\.textTracks\[0\]\.events\[0\]\.at/);
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, textTracks: [{ selector: "#x", events: [{ type: "park", at: 0, charOffset: -2 }] }] }],
        }),
      ).toThrow(/frames\[0\]\.textTracks\[0\]\.events\[0\]\.charOffset/);
    });

    it("rejects textTracks on a frame without a single captured tree", () => {
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, scroll: { pattern: "down" }, textTracks: [{ selector: "#x", events: [{ type: "hide", at: 0 }] }] }],
        }),
      ).toThrow(/`textTracks` needs this frame's captured tree — it cannot be combined with `scroll`/);
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, states: [{ duration: 100 }], textTracks: [{ selector: "#x", events: [{ type: "hide", at: 0 }] }] }],
        }),
      ).toThrow(/`textTracks` needs this frame's captured tree — it cannot be combined with `states`/);
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ cast: "x.cast", duration: 1, textTracks: [{ selector: "#x", events: [{ type: "hide", at: 0 }] }] }],
        }),
      ).toThrow(/`textTracks` needs this frame's captured tree — it cannot be combined with `cast`/);
    });

    it("configTextTrackSpec maps frame-relative times to global time and animIds to the stamping convention", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{
          input: "a.html",
          duration: 4000,
          textTracks: [{
            selector: "#line",
            shape: "underscore",
            events: [
              { type: "park", at: 100, charOffset: 2 },
              { type: "move", at: 900, charOffset: 4, selector: "#other" },
              { type: "select", at: 1500, charStart: 1, charEnd: 3, sweepMs: 250 },
              { type: "clearSelection", at: 2500 },
              { type: "hide", at: 3000 },
            ],
          }],
        }],
      });
      const spec = configTextTrackSpec(cfg.frames[0].textTracks![0], 2, 1, 5000);
      expect(spec.target).toEqual({ animId: "f2tt1" });
      expect(spec.shape).toBe("underscore");
      expect(spec.events).toEqual([
        { type: "park", t: 5100, charOffset: 2 },
        { type: "move", t: 5900, charOffset: 4, target: { animId: "f2tt1e1" } },
        { type: "select", t: 6500, charStart: 1, charEnd: 3, sweepMs: 250 },
        { type: "clearSelection", t: 7500 },
        { type: "hide", t: 8000 },
      ]);
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

    // DM-1750: `anchor.baseline` resolves a typing overlay's y to the anchored
    // element's first-line text baseline. Typing-only, enforced at the schema.
    it("DM-1750: accepts anchor.baseline on a typing overlay, rejects it on other kinds", () => {
      const cfg = validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, overlays: [
          { kind: "typing", text: "hi", anchor: { selector: ".f", baseline: true } },
        ] }],
      });
      expect(cfg.frames[0].overlays?.[0]).toMatchObject({ kind: "typing", anchor: { selector: ".f", baseline: true } });
      // Any non-typing anchor is strict: `baseline` fails at its config path
      // instead of being silently stripped (a tap's y is a box corner, not a
      // text baseline).
      expect(() => validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, overlays: [
          { kind: "tap", anchor: { selector: ".c", baseline: true } },
        ] }],
      })).toThrow(/frames\[0\].overlays\[0\].anchor/);
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

  it("substitutes ${name} inside `states` actions and `textTracks` selectors (DM-1747)", () => {
    const out = interpolateConfigVars(validateAnimateConfig({
      ...base,
      vars: { line: "#line-1", ins: "ins(2)" },
      frames: [
        {
          input: "editor.html", duration: 1000,
          states: [{ duration: 100 }, { actions: [{ type: "evaluate", script: "${ins}" }, { type: "setText", selector: "${line}", value: "x" }], duration: 100 }],
        },
        {
          continue: true, duration: 1000,
          textTracks: [{ selector: "${line}", events: [{ type: "move", at: 0, charOffset: 1, selector: "${line}" }] }],
        },
      ],
    }));
    const stActions = out.frames[0].states![1].actions!;
    expect(stActions[0].type === "evaluate" ? stActions[0].script : "").toBe("ins(2)");
    expect("selector" in stActions[1] ? stActions[1].selector : "").toBe("#line-1");
    const tt = out.frames[1].textTracks![0];
    expect(tt.selector).toBe("#line-1");
    const ev = tt.events[0];
    expect(ev.type === "move" ? ev.selector : "").toBe("#line-1");
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

  // DM-1742: interaction actions carry an optional cursor aim so `cursor:
  // "auto"` can land the pointer beside a label the viewer must read instead
  // of dead-center (the invisible-child-pad workaround).
  it("accepts cursorAt / cursorOffset on click, fill, and hover actions", () => {
    const cfg = validateAnimateConfig({
      ...base,
      cursor: "auto",
      frames: [{
        input: "a.html", duration: 1,
        actions: [
          { type: "click", selector: ".b", cursorAt: "bottom-right", cursorOffset: { dx: -4, dy: 8 } },
          { type: "fill", selector: ".in", value: "x", cursorOffset: { dx: 40 } },
          { type: "hover", selector: ".h", cursorAt: "left" },
        ],
      }],
    });
    const acts = cfg.frames[0].actions!;
    expect(acts[0]).toMatchObject({ cursorAt: "bottom-right", cursorOffset: { dx: -4, dy: 8 } });
    expect(acts[1]).toMatchObject({ cursorOffset: { dx: 40 } });
    expect(acts[2]).toMatchObject({ cursorAt: "left" });
  });

  it("rejects an unknown cursorAt anchor keyword", () => {
    expect(() =>
      validateAnimateConfig({
        ...base,
        frames: [{ input: "a.html", duration: 1, actions: [{ type: "click", selector: ".b", cursorAt: "middle" }] }],
      }),
    ).toThrow();
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

describe("placeEmbeddedFrame: template-frame fit policy (DM-1293)", () => {
  it("center: exact fit returns content untouched (no wrapper)", () => {
    expect(placeEmbeddedFrame("<g/>", 800, 450, 800, 450, "center")).toBe("<g/>");
  });

  it("center: smaller content is translated, not scaled", () => {
    const out = placeEmbeddedFrame("<g/>", 400, 200, 800, 450, "center");
    expect(out).toBe(`<g transform="translate(200,125)"><g/></g>`);
    expect(out).not.toContain("scale(");
  });

  it("center: oversized content gets a negative offset (clipped by the viewport)", () => {
    const out = placeEmbeddedFrame("<g/>", 1000, 600, 800, 450, "center");
    expect(out).toBe(`<g transform="translate(-100,-75)"><g/></g>`);
  });

  it("contain: scales DOWN by the limiting axis, preserving aspect, centered", () => {
    // 400×400 into 800×450 → min(2, 1.125) = 1.125; scaled 450×450; centered x.
    const out = placeEmbeddedFrame("<g/>", 400, 400, 800, 450, "contain");
    expect(out).toBe(`<g transform="translate(175,0) scale(1.125)"><g/></g>`);
  });

  it("cover: scales UP by the larger axis, preserving aspect, centered (overflow clipped)", () => {
    // 400×400 into 800×450 → max(2, 1.125) = 2; scaled 800×800; centered y → (800-800)/2=0, (450-800)/2=-175.
    const out = placeEmbeddedFrame("<g/>", 400, 400, 800, 450, "cover");
    expect(out).toBe(`<g transform="translate(0,-175) scale(2)"><g/></g>`);
  });

  it("contain on an already-fitting square is a no-op-ish identity scale (no wrapper)", () => {
    expect(placeEmbeddedFrame("<g/>", 800, 450, 800, 450, "contain")).toBe("<g/>");
  });
});

// DM-1320: overlays on a cast / template frame have no captured DOM, so a
// selector anchor (or typing maxWidth:"anchor") can't resolve. Previously the
// whole overlay was silently dropped; now it warns clearly and falls back to
// the overlay's explicit x/y so explicit-coordinate overlays still render.
describe("resolveEmbeddedFrameOverlays — overlays on cast/template frames (DM-1320)", () => {
  it("warns and strips a selector anchor, keeping the overlay (falls back to x/y)", () => {
    const logs: string[] = [];
    const out = resolveEmbeddedFrameOverlays(
      [{ kind: "tap", x: 0, y: 0, anchor: { selector: ".btn", at: "center" } }],
      process.cwd(), 0, "cast", (m) => logs.push(m),
    );
    expect(out).toHaveLength(1);
    expect((out![0] as { anchor?: unknown }).anchor).toBeUndefined();
    expect(logs.join("\n")).toMatch(/anchor.*\.btn.*ignored on a cast frame/);
  });

  it("warns for typing maxWidth:'anchor' and drops it", () => {
    const logs: string[] = [];
    const out = resolveEmbeddedFrameOverlays(
      [{ kind: "typing", x: 10, y: 20, text: "hi", maxWidth: "anchor" }],
      process.cwd(), 1, "template", (m) => logs.push(m),
    );
    expect((out![0] as { maxWidth?: unknown }).maxWidth).toBeUndefined();
    expect(logs.join("\n")).toMatch(/maxWidth:"anchor" is ignored on a template frame/);
  });

  it("passes explicit-coordinate overlays through untouched (no warning)", () => {
    const logs: string[] = [];
    const out = resolveEmbeddedFrameOverlays(
      [{ kind: "tap", x: 100, y: 50 }],
      process.cwd(), 0, "cast", (m) => logs.push(m),
    );
    expect(out).toEqual([{ kind: "tap", x: 100, y: 50 }]);
    expect(logs).toHaveLength(0);
  });

  it("returns undefined when there are no overlays", () => {
    expect(resolveEmbeddedFrameOverlays(undefined, process.cwd(), 0, "cast", () => {})).toBeUndefined();
  });
});

describe("config `brand` key (DM-1544)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "domotion-animate-brand-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const frame = { input: "a.html", duration: 100 };

  it("accepts a string brand path", () => {
    const cfg = validateAnimateConfig({ ...base, brand: "acme.json", frames: [frame] });
    expect(cfg.brand).toBe("acme.json");
  });

  it("accepts an inline brand object validated by brandSchema (coercing radius)", () => {
    const cfg = validateAnimateConfig({
      ...base,
      brand: { palette: { primary: "#f00" }, font: { family: "Inter" }, radius: "8", logo: "logo.svg" },
      frames: [frame],
    });
    expect(cfg.brand).toMatchObject({ palette: { primary: "#f00" }, radius: 8, logo: "logo.svg" });
  });

  it("rejects an inline brand with a wrong-typed token", () => {
    expect(() => validateAnimateConfig({ ...base, brand: { palette: { primary: 123 } }, frames: [frame] }))
      .toThrow(/brand/);
  });

  it("resolveConfigBrand loads a string path relative to configDir", () => {
    const p = join(dir, "acme.json");
    writeFileSync(p, JSON.stringify({ palette: { primary: "#0af" }, logo: "acme-logo.svg" }));
    const brand = resolveConfigBrand("acme.json", dir);
    expect(brand?.palette?.primary).toBe("#0af");
    // loadBrand resolves the file's own relative logo against the file's dir.
    expect(brand?.logo).toBe(resolve(dir, "acme-logo.svg"));
  });

  it("resolveConfigBrand resolves an inline object's relative logo against configDir", () => {
    const brand = resolveConfigBrand({ palette: { primary: "#0af" }, logo: "brand/logo.svg" }, dir);
    expect(brand?.logo).toBe(resolve(dir, "brand/logo.svg"));
  });

  it("resolveConfigBrand leaves an absolute path / URL logo untouched", () => {
    expect(resolveConfigBrand({ logo: "/opt/l.svg" }, dir)?.logo).toBe("/opt/l.svg");
    expect(resolveConfigBrand({ logo: "https://cdn.example.com/l.svg" }, dir)?.logo).toBe("https://cdn.example.com/l.svg");
  });

  it("resolveConfigBrand returns undefined for an absent brand", () => {
    expect(resolveConfigBrand(undefined, dir)).toBeUndefined();
  });
});
