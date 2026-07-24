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
import { validateAnimateConfig, interpolateConfigVars, resolveConfigBrand, buildCursorOverlay, placeEmbeddedFrame, resolveEmbeddedFrameOverlays, configTextTrackSpec, autoCompressRuns, compressMarkedRuns, composeStatesFlipbook, wasAutoCollapsed, planRegionCaptureRounds, type AnimateConfig } from "./animate.js";
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

  describe("explicit `regions` + per-state `advances` (DM-1770, docs/43 §11.1)", () => {
    const withRegions = (over: Record<string, unknown>) => ({
      ...base,
      frames: [{
        input: "panes.html", duration: 900,
        regions: { editor: "#ed", preview: "#pv" },
        states: [{ duration: 300 }, { duration: 300 }, { duration: 300 }],
        ...over,
      }],
    });

    it("accepts a regions map with per-state advances", () => {
      const cfg = validateAnimateConfig(withRegions({
        states: [
          { duration: 300 },
          { advances: ["editor"], actions: [{ type: "evaluate", script: "setLeft(2)" }], duration: 300 },
          { advances: ["preview", "editor"], duration: 300 },
        ],
      }));
      expect(cfg.frames[0].regions).toEqual({ editor: "#ed", preview: "#pv" });
      expect(cfg.frames[0].states![1].advances).toEqual(["editor"]);
      expect(cfg.frames[0].states![2].advances).toEqual(["preview", "editor"]);
    });

    it("accepts `regions` with no `advances` at all (a discriminator override)", () => {
      const cfg = validateAnimateConfig(withRegions({}));
      expect(cfg.frames[0].regions).toEqual({ editor: "#ed", preview: "#pv" });
      expect(cfg.frames[0].states!.every((s) => s.advances == null)).toBe(true);
    });

    it("rejects `regions` without `states` (path-specific)", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, regions: { a: "#a" } }] }),
      ).toThrow(/frames\[0\]\.regions: `regions` requires a `states` compressed run/);
    });

    it("rejects an empty regions map", () => {
      expect(() =>
        validateAnimateConfig({ ...base, frames: [{ input: "a.html", duration: 1, regions: {}, states: [{ duration: 1 }] }] }),
      ).toThrow(/frames\[0\]\.regions/);
    });

    it("rejects `advances` on a frame that declares no `regions`", () => {
      expect(() =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 1, states: [{ duration: 1 }, { advances: ["editor"], duration: 1 }] }],
        }),
      ).toThrow(/frames\[0\]\.states\[1\]\.advances: `advances` requires the frame to declare `regions`/);
    });

    it("rejects `advances` naming an undeclared region, listing what IS declared", () => {
      expect(() =>
        validateAnimateConfig(withRegions({
          states: [{ duration: 1 }, { advances: ["previw"], duration: 1 }],
        })),
      ).toThrow(/frames\[0\]\.states\[1\]\.advances\[0\]: unknown region "previw" — this frame declares "editor", "preview"/);
    });

    it("rejects `advances` on state 0 — every region's starting point", () => {
      expect(() =>
        validateAnimateConfig(withRegions({ states: [{ advances: ["editor"], duration: 1 }, { duration: 1 }] })),
      ).toThrow(/frames\[0\]\.states\[0\]\.advances: state 0 is the frame's own post-`actions` state/);
    });

    it("rejects an empty or duplicated advances list", () => {
      expect(() =>
        validateAnimateConfig(withRegions({ states: [{ duration: 1 }, { advances: [], duration: 1 }] })),
      ).toThrow(/frames\[0\]\.states\[1\]\.advances: must name at least one region/);
      expect(() =>
        validateAnimateConfig(withRegions({ states: [{ duration: 1 }, { advances: ["editor", "editor"], duration: 1 }] })),
      ).toThrow(/frames\[0\]\.states\[1\]\.advances\[1\]: region "editor" is listed twice/);
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
      // The authored events already end the track (clearSelection + hide), so
      // the DM-1763 auto-end synthesizes nothing — the mapping is 1:1.
      const spec = configTextTrackSpec(cfg.frames[0].textTracks![0], 2, 1, 5000, 4000);
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

    // DM-1763: a frame's track ends at that frame's cut by default. The CLI
    // synthesizes the trailing hide (and clearSelection if a selection is still
    // active) at the frame's duration; `persist: true` opts out; an author's own
    // terminal hide/clearSelection is never doubled.
    describe("auto-end at the frame's cut (DM-1763)", () => {
      const track = (events: unknown[], extra: Record<string, unknown> = {}) =>
        validateAnimateConfig({
          ...base,
          frames: [{ input: "a.html", duration: 2000, textTracks: [{ selector: "#line", events, ...extra }] }],
        }).frames[0].textTracks![0];

      it("synthesizes a hide at the frame duration when the caret is left parked", () => {
        const spec = configTextTrackSpec(track([{ type: "park", at: 100, charOffset: 3 }]), 0, 0, 0, 2000);
        expect(spec.events).toEqual([
          { type: "park", t: 100, charOffset: 3 },
          { type: "hide", t: 2000 },
        ]);
      });

      it("synthesizes clearSelection + hide (in that order) when a selection is active and the caret parked", () => {
        const spec = configTextTrackSpec(
          track([
            { type: "park", at: 100, charOffset: 0 },
            { type: "select", at: 300, charStart: 0, charEnd: 4, sweepMs: 200 },
          ]),
          1, 0, 5000, 2000,
        );
        expect(spec.events).toEqual([
          { type: "park", t: 5100, charOffset: 0 },
          { type: "select", t: 5300, charStart: 0, charEnd: 4, sweepMs: 200 },
          { type: "clearSelection", t: 7000 },
          { type: "hide", t: 7000 },
        ]);
      });

      it("does not synthesize a selection clear when the caret was moved but no selection is active", () => {
        // A select followed by an explicit clearSelection leaves only the caret on.
        const spec = configTextTrackSpec(
          track([
            { type: "select", at: 100, charStart: 0, charEnd: 3 },
            { type: "clearSelection", at: 500 },
            { type: "move", at: 600, charOffset: 3 },
          ]),
          0, 0, 0, 2000,
        );
        expect(spec.events.filter((e) => e.type === "clearSelection")).toHaveLength(1);
        expect(spec.events.at(-1)).toEqual({ type: "hide", t: 2000 });
      });

      it("does not double the author's own terminal hide", () => {
        const spec = configTextTrackSpec(
          track([
            { type: "park", at: 100, charOffset: 3 },
            { type: "hide", at: 1800 },
          ]),
          0, 0, 0, 2000,
        );
        expect(spec.events).toEqual([
          { type: "park", t: 100, charOffset: 3 },
          { type: "hide", t: 1800 },
        ]);
        expect(spec.events.filter((e) => e.type === "hide")).toHaveLength(1);
      });

      it("does not double the author's own terminal clearSelection + hide", () => {
        const spec = configTextTrackSpec(
          track([
            { type: "park", at: 100, charOffset: 0 },
            { type: "select", at: 300, charStart: 0, charEnd: 4 },
            { type: "clearSelection", at: 1900 },
            { type: "hide", at: 1900 },
          ]),
          0, 0, 0, 2000,
        );
        expect(spec.events.filter((e) => e.type === "hide")).toHaveLength(1);
        expect(spec.events.filter((e) => e.type === "clearSelection")).toHaveLength(1);
      });

      it("persist: true suppresses all synthesized end events", () => {
        const spec = configTextTrackSpec(
          track([
            { type: "park", at: 100, charOffset: 0 },
            { type: "select", at: 300, charStart: 0, charEnd: 4 },
          ], { persist: true }),
          0, 0, 0, 2000,
        );
        expect(spec.events).toEqual([
          { type: "park", t: 100, charOffset: 0 },
          { type: "select", t: 300, charStart: 0, charEnd: 4 },
        ]);
      });
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

  it("substitutes ${name} inside `regions` SELECTORS, and leaves region names literal (DM-1770)", () => {
    // A region's selector is a selector like any other, so it interpolates.
    // Its NAME is a config-internal identifier: `regions`' own object keys are
    // never interpolated (keys never are), so the `advances` entries that must
    // match them stay literal too — otherwise the two halves of one identifier
    // would follow different rules, and the "is this region declared?" check
    // runs at parse time, before any substitution could happen.
    const out = interpolateConfigVars(validateAnimateConfig({
      ...base,
      vars: { pane: "#ed" },
      frames: [{
        input: "panes.html", duration: 1000,
        regions: { editor: "${pane}", preview: "#pv" },
        states: [{ duration: 100 }, { advances: ["editor"], duration: 100 }],
      }],
    }));
    expect(out.frames[0].regions).toEqual({ editor: "#ed", preview: "#pv" });
    expect(out.frames[0].states![1].advances).toEqual(["editor"]);
  });

  it("leaves a ${...}-looking region name alone rather than substituting it (DM-1770)", () => {
    const out = interpolateConfigVars({
      ...base,
      vars: { left: "editor" },
      frames: [{
        input: "panes.html", duration: 1000,
        regions: { "${left}": "#ed" },
        states: [{ duration: 100 }, { advances: ["${left}"], duration: 100 }],
      }],
    } as unknown as AnimateConfig);
    expect(Object.keys(out.frames[0].regions!)).toEqual(["${left}"]);
    expect(out.frames[0].states![1].advances).toEqual(["${left}"]);
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

describe("autoCompressRuns (DM-1757): automatic compressed-run detection", () => {
  const B = { width: 200, height: 120 };
  const cut = { type: "cut", duration: 0 } as const;
  const cfgOf = (frames: unknown[], extra: Record<string, unknown> = {}) =>
    validateAnimateConfig({ ...B, ...extra, frames });

  it("is a no-op when autoCompress is off (frames unchanged)", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },
    ]);
    expect(autoCompressRuns(cfg)).toBe(cfg);
  });

  it("collapses a maximal continue+cut run into ONE states frame", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut, actions: [{ type: "evaluate", script: "s(0)" }] },
      { continue: true, duration: 120, transition: cut, actions: [{ type: "evaluate", script: "s(1)" }] },
      { continue: true, duration: 140, transition: cut, actions: [{ type: "evaluate", script: "s(2)" }] },
    ], { autoCompress: true });
    const out = autoCompressRuns(cfg);
    expect(out.frames).toHaveLength(1);
    const f = out.frames[0];
    expect(f.input).toBe("a.html");
    expect(f.duration).toBe(360); // 100 + 120 + 140
    expect(f.transition).toEqual(cut);
    // Anchor's own actions stay frame-level; state 0 has none (it's the
    // post-actions capture). Later states carry their frames' actions.
    expect(f.actions).toEqual([{ type: "evaluate", script: "s(0)" }]);
    expect(f.states).toEqual([
      { duration: 100 },
      { actions: [{ type: "evaluate", script: "s(1)" }], duration: 120 },
      { actions: [{ type: "evaluate", script: "s(2)" }], duration: 140 },
    ]);
  });

  it("uses `continue: true` on the collapsed frame when the anchor is a continue frame", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: { type: "crossfade", duration: 200 } }, // standalone (crossfade)
      { continue: true, duration: 100, transition: cut }, // anchor of the run
      { continue: true, duration: 100, transition: cut },
    ], { autoCompress: true });
    const out = autoCompressRuns(cfg);
    expect(out.frames).toHaveLength(2);
    expect(out.frames[0].transition).toEqual({ type: "crossfade", duration: 200 });
    expect(out.frames[1].continue).toBe(true);
    expect(out.frames[1].input).toBeUndefined();
    expect(out.frames[1].states).toHaveLength(2);
  });

  it("does not collapse a single continue+cut frame (needs >= 2)", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: { type: "crossfade", duration: 100 } },
      { continue: true, duration: 100, transition: cut },
    ], { autoCompress: true });
    // Frame 0 alone (frame 1 is crossfade → not a member) is length-1 → not collapsed.
    // Frame 2 alone is length-1 → not collapsed. Nothing collapses.
    expect(autoCompressRuns(cfg)).toBe(cfg);
  });

  it("stops the run at a non-cut (crossfade) transition and collapses two separate runs", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },     // run A ends here (out-transition cut into f2)
      { continue: true, duration: 100, transition: { type: "crossfade", duration: 150 } }, // standalone (crossfade out)
      { continue: true, duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },     // run B
    ], { autoCompress: true });
    const out = autoCompressRuns(cfg);
    // run A = [0,1] → 1 frame; f2 standalone; run B = [3,4] → 1 frame. 5 → 3.
    expect(out.frames).toHaveLength(3);
    expect(out.frames[0].states).toHaveLength(2);
    expect(out.frames[1].transition).toEqual({ type: "crossfade", duration: 150 });
    expect(out.frames[1].states).toBeUndefined();
    expect(out.frames[2].states).toHaveLength(2);
  });

  it("excludes frames carrying overlays / animations / forceState from a run", () => {
    for (const feature of [
      { overlays: [{ kind: "typing", text: "x", x: 0, y: 0 }] },
      { animations: [{ selector: "#a", property: "opacity", from: "0", to: "1", duration: 100 }] },
      { forceState: [{ selector: "#a", states: ["hover"] }] },
    ]) {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut, ...feature },
        { continue: true, duration: 100, transition: cut },
      ], { autoCompress: true });
      const out = autoCompressRuns(cfg);
      // The feature frame breaks the run: frame 0 (len 1) and frame 2 (len 1) → nothing collapses.
      expect(out.frames, JSON.stringify(feature)).toHaveLength(3);
    }
  });

  it("ends a run at a non-anchor readiness wait, but that frame can anchor the NEXT run", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut, waitFor: ".ready" }, // ends run [0,1]; anchors run [2,3]
      { continue: true, duration: 100, transition: cut },
    ], { autoCompress: true });
    const out = autoCompressRuns(cfg);
    // A waitFor disqualifies a frame as a NON-anchor member (state runs have no
    // per-state readiness wait), so it ends run [0,1]. But an anchor MAY carry a
    // readiness wait (preserved on the collapsed frame), so frame 2 seeds run
    // [2,3]. Result: two collapsed frames, the second preserving waitFor.
    expect(out.frames).toHaveLength(2);
    expect(out.frames[0].states).toHaveLength(2);
    expect(out.frames[1].waitFor).toBe(".ready");
    expect(out.frames[1].continue).toBe(true);
    expect(out.frames[1].states).toHaveLength(2);
  });

  it("leaves a run uncompressed when an explicit cursor event addresses a member", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut },
    ], {
      autoCompress: true,
      cursor: { events: [{ frame: 1, at: 0, type: "click", selector: "#btn" }] },
    });
    // The run [0,1,2] is rejected (cursor addresses frame 1). Unchanged.
    expect(autoCompressRuns(cfg).frames).toHaveLength(3);
  });

  it("leaves a run uncompressed when it is entered via a magic-move transition", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: { type: "magic-move", duration: 300 } },
      { continue: true, duration: 100, transition: cut }, // anchor — entered via magic-move
      { continue: true, duration: 100, transition: cut },
    ], { autoCompress: true });
    const out = autoCompressRuns(cfg);
    // Run [1,2] rejected (magic-move entry). Frame 0 standalone. 3 frames unchanged.
    expect(out.frames).toHaveLength(3);
    expect(out.frames[1].states).toBeUndefined();
  });

  it("under cursor:auto, leaves a run with an interaction action uncompressed", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut, actions: [{ type: "click", selector: "#b" }] },
      { continue: true, duration: 100, transition: cut },
    ], { autoCompress: true, cursor: "auto" });
    expect(autoCompressRuns(cfg).frames).toHaveLength(3);
  });

  it("under cursor:auto, still collapses a run whose actions are non-interaction (evaluate/DOM)", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut, actions: [{ type: "evaluate", script: "s(1)" }] },
      { continue: true, duration: 100, transition: cut, actions: [{ type: "setText", selector: "#x", value: "y" }] },
    ], { autoCompress: true, cursor: "auto" });
    const out = autoCompressRuns(cfg);
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0].states).toHaveLength(3);
    expect(out.cursor).toBe("auto");
  });

  // DM-1764: a single-frame reason (a cursor event, an auto-cursor interaction,
  // a magic-move landing) splits the candidate window instead of dropping it.
  describe("sub-run splitting around a single ineligible frame (DM-1764)", () => {
    it("splits a run around a cursor-addressed member and collapses both sides", () => {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },   // ← cursor event here
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
      ], {
        autoCompress: true,
        cursor: { events: [{ frame: 2, at: 0, type: "click", selector: "#btn" }] },
      });
      const out = autoCompressRuns(cfg);
      // [0,1] → one run, frame 2 stays plain, [3,4] → one run. 5 → 3.
      expect(out.frames).toHaveLength(3);
      expect(out.frames[0].states).toHaveLength(2);
      expect(out.frames[1].states).toBeUndefined();
      expect(out.frames[2].states).toHaveLength(2);
      // The cursor event still addresses the (reindexed) plain frame.
      if (out.cursor == null || out.cursor === "auto") throw new Error("expected an explicit cursor event list");
      expect(out.cursor.events[0].frame).toBe(1);
    });

    it("splits under cursor:auto around the member carrying the interaction action", () => {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut, actions: [{ type: "click", selector: "#b" }] },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
      ], { autoCompress: true, cursor: "auto" });
      const out = autoCompressRuns(cfg);
      expect(out.frames).toHaveLength(3);
      expect(out.frames[0].states).toHaveLength(2);
      expect(out.frames[1].actions).toEqual([{ type: "click", selector: "#b" }]);
      expect(out.frames[1].states).toBeUndefined();
      expect(out.frames[2].states).toHaveLength(2);
    });

    it("splits off a magic-move-entered anchor and still collapses the rest", () => {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: { type: "magic-move", duration: 300 } },
        { continue: true, duration: 100, transition: cut },  // anchor — entered via magic-move
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
      ], { autoCompress: true });
      const out = autoCompressRuns(cfg);
      // Frame 0 keeps its magic-move INTO frame 1, which stays a plain captured
      // frame (so the transition still has a tree to morph into); [2,3] collapse.
      expect(out.frames).toHaveLength(3);
      expect(out.frames[0].transition).toEqual({ type: "magic-move", duration: 300 });
      expect(out.frames[1].states).toBeUndefined();
      expect(out.frames[2].states).toHaveLength(2);
      expect(out.frames[2].duration).toBe(200);
    });

    it("splits around MULTIPLE ineligible frames in one window", () => {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },   // ← cursor
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },   // ← cursor
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
      ], {
        autoCompress: true,
        cursor: { events: [
          { frame: 2, at: 0, type: "click", selector: "#a" },
          { frame: 5, at: 0, type: "click", selector: "#b" },
        ] },
      });
      const out = autoCompressRuns(cfg);
      // [0,1] run · 2 plain · [3,4] run · 5 plain · [6,7] run → 5 frames.
      expect(out.frames.map((f) => f.states?.length ?? 0)).toEqual([2, 0, 2, 0, 2]);
      expect(out.cursor === "auto" ? [] : (out.cursor?.events ?? []).map((e) => e.frame)).toEqual([1, 3]);
    });

    it("leaves a 1-frame remnant plain (a compressed run needs >= 2 states)", () => {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },   // ← cursor: remnant [0] is 1 frame
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
      ], {
        autoCompress: true,
        cursor: { events: [{ frame: 1, at: 0, type: "click", selector: "#a" }] },
      });
      const out = autoCompressRuns(cfg);
      expect(out.frames.map((f) => f.states?.length ?? 0)).toEqual([0, 0, 2]);
    });

    it("logs the split frame with its reason, and the surviving sub-runs", () => {
      const logs: string[] = [];
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },
      ], {
        autoCompress: true,
        cursor: { events: [{ frame: 2, at: 0, type: "click", selector: "#btn" }] },
      });
      autoCompressRuns(cfg, (m) => logs.push(m));
      expect(logs.some((l) => /auto-compress: leaving frame 2 uncompressed — an explicit cursor event addresses frame 2/.test(l))).toBe(true);
      expect(logs.some((l) => /auto-compress: collapsed frames 0–1 into a states run/.test(l))).toBe(true);
      expect(logs.some((l) => /auto-compress: collapsed frames 3–4 into a states run/.test(l))).toBe(true);
    });

    it("keeps the marker mode's hard error for a run containing a split point", () => {
      const cfg = cfgOf([
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut },   // ← cursor
        { continue: true, duration: 100, transition: cut },
      ], { cursor: { events: [{ frame: 2, at: 0, type: "click", selector: "#a" }] } });
      // The author asked for THIS run; compressing a shorter piece of it would
      // hide the mismatch, so the marker still fails loudly.
      expect(() => compressMarkedRuns(cfg)).toThrow(/an explicit cursor event addresses frame 2 inside it/);
    });
  });

  it("remaps explicit cursor-event frame indices across collapsed runs", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },  // run A member
      { continue: true, duration: 100, transition: cut },   // run A member
      { continue: true, duration: 100, transition: { type: "crossfade", duration: 150 } }, // standalone (idx 2 → 1)
      { continue: true, duration: 100, transition: cut },   // run B member
      { continue: true, duration: 100, transition: cut },   // run B member
    ], {
      autoCompress: true,
      cursor: { events: [{ frame: 2, at: 0, type: "click", selector: "#c" }] },
    });
    const out = autoCompressRuns(cfg);
    expect(out.frames).toHaveLength(3); // [0,1]→0, 2→1, [3,4]→2
    expect(out.cursor).not.toBe("auto");
    if (out.cursor != null && out.cursor !== "auto") {
      expect(out.cursor.events[0].frame).toBe(1); // original frame 2 → new index 1
    }
  });
});

describe("planRegionCaptureRounds (DM-1770): independent per-region timing", () => {
  const st = (...advances: string[][]) => [{} as { advances?: string[] }, ...advances.map((a) => ({ advances: a }))];

  it("collapses two disjoint schedules to 1 + max(nᵢ) whole-page captures", () => {
    // A on states 1/3/5, B on 2/4/6 — the shape a hand-interleaved sequence
    // pays 7 captures for.
    const plan = planRegionCaptureRounds(st(["a"], ["b"], ["a"], ["b"], ["a"], ["b"]), ["a", "b"]);
    expect(plan.rounds).toEqual([[], [1, 2], [3, 4], [5, 6]]);
    expect(plan.rounds).toHaveLength(4);
    // Each state reads each region from the round holding that region's own
    // state — state 1 is A-advanced but B still at its start.
    expect(plan.sourceRound[0]).toEqual({ a: 0, b: 0 });
    expect(plan.sourceRound[1]).toEqual({ a: 1, b: 0 });
    expect(plan.sourceRound[2]).toEqual({ a: 1, b: 1 });
    expect(plan.sourceRound[6]).toEqual({ a: 3, b: 3 });
  });

  it("scales with the number of regions: 3 regions x 4 advances is 13 states in 5 captures", () => {
    const advances: string[][] = [];
    for (let k = 0; k < 4; k++) for (const n of ["a", "b", "c"]) advances.push([n]);
    const plan = planRegionCaptureRounds(st(...advances), ["a", "b", "c"]);
    expect(plan.rounds).toHaveLength(5);
    expect(plan.sourceRound).toHaveLength(13);
  });

  it("a state advancing several regions chains them into one round", () => {
    // The state's actions are one indivisible script, so it takes ONE round —
    // one past the latest round of every region it advances.
    const plan = planRegionCaptureRounds(st(["a"], ["b"], ["a", "b"]), ["a", "b"]);
    expect(plan.rounds).toEqual([[], [1, 2], [3]]);
    expect(plan.sourceRound[3]).toEqual({ a: 2, b: 2 });
  });

  it("a region's advances always land in strictly increasing rounds", () => {
    // Rounds are cumulative (the page carries forward), so a region can never
    // read a later state from an earlier round.
    const plan = planRegionCaptureRounds(st(["a"], ["a"], ["b"], ["a"]), ["a", "b"]);
    expect(plan.rounds).toEqual([[], [1, 3], [2], [4]]);
    let prev = -1;
    for (const s of plan.sourceRound) {
      expect(s.a).toBeGreaterThanOrEqual(prev);
      prev = s.a;
    }
    expect(plan.sourceRound.map((s) => s.a)).toEqual([0, 1, 2, 2, 3]);
    expect(plan.sourceRound.map((s) => s.b)).toEqual([0, 0, 0, 1, 1]);
  });

  it("states with no `advances` advance every region — one round each, the sequential default", () => {
    const plan = planRegionCaptureRounds([{}, {}, {}], ["a", "b"]);
    expect(plan.rounds).toEqual([[], [1], [2]]);
    expect(plan.sourceRound).toEqual([{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: 2, b: 2 }]);
  });

  it("a single state needs exactly one capture", () => {
    expect(planRegionCaptureRounds([{}], ["a"]).rounds).toEqual([[]]);
  });
});

describe("size-regression guard (DM-1764)", () => {
  const B = { width: 200, height: 120 };
  const cut = { type: "cut", duration: 0 } as const;
  const cfgOf = (frames: unknown[], extra: Record<string, unknown> = {}) =>
    validateAnimateConfig({ ...B, ...extra, frames });
  // Typed loosely on purpose: these fixtures get a `compress` marker patched in
  // per case, and `validateAnimateConfig` is the thing under test for shape.
  const eligible3 = (): Record<string, unknown>[] => [
    { input: "a.html", duration: 100, transition: cut },
    { continue: true, duration: 100, transition: cut },
    { continue: true, duration: 100, transition: cut },
  ];

  describe("guard eligibility — only the automatic pass's runs revert", () => {
    it("flags a run the automatic pass collapsed", () => {
      const out = autoCompressRuns(cfgOf(eligible3(), { autoCompress: true }));
      expect(out.frames).toHaveLength(1);
      expect(wasAutoCollapsed(out.frames[0])).toBe(true);
    });

    it("does NOT flag a run the author marked with `compress: true`", () => {
      const frames = eligible3();
      frames[0] = { ...frames[0], compress: true };
      const out = compressMarkedRuns(cfgOf(frames));
      // The author asked for this one, so the guard warns rather than silently
      // rewriting what they wrote — the same contract as the marker's hard error.
      expect(out.frames).toHaveLength(1);
      expect(wasAutoCollapsed(out.frames[0])).toBe(false);
    });

    it("does NOT flag a hand-authored `states:` frame", () => {
      const cfg = cfgOf([{ input: "a.html", duration: 200, transition: cut, states: [{ duration: 100 }, { duration: 100 }] }]);
      expect(wasAutoCollapsed(cfg.frames[0])).toBe(false);
    });
  });

  // The uncompressed alternative the guard falls back to: the same N states,
  // still nested in ONE frame, each gated by a step-end display track.
  describe("composeStatesFlipbook", () => {
    const holds = [100, 200, 300];
    const trees = [[], [], []];

    it("spans the run's total duration", () => {
      expect(composeStatesFlipbook(trees, holds, 200, 120, "cr").durationMs).toBe(600);
    });

    it("gates each state's group on a step-end display window", () => {
      const { svg } = composeStatesFlipbook(trees, holds, 200, 120, "cr");
      // State 0 holds 0–100ms of 600 (0–16.6667%), state 1 to 300ms (50%),
      // state 2 to the end. Exactly one group is `inline` at any instant.
      expect(svg).toContain("@keyframes crfb0{0%{display:inline}16.6667%{display:none}100%{display:none}}");
      expect(svg).toContain("@keyframes crfb1{0%{display:none}16.6667%{display:inline}50%{display:none}100%{display:none}}");
      expect(svg).toContain("@keyframes crfb2{0%{display:none}50%{display:inline}100%{display:inline}}");
      expect(svg).toContain("#crfb0{animation:crfb0 0.600s step-end infinite}");
      expect(svg).toContain("#crfb2{animation:crfb2 0.600s step-end infinite}");
      for (const id of ["crfb0", "crfb1", "crfb2"]) expect(svg).toContain(`<g id="${id}">`);
    });

    it("paints the captured root background when there is one", () => {
      expect(composeStatesFlipbook(trees, holds, 200, 120, "cr", "rgb(30, 41, 59)").svg)
        .toContain(`<rect width="200" height="120" fill="rgb(30, 41, 59)"/>`);
      expect(composeStatesFlipbook(trees, holds, 200, 120, "cr").svg).not.toContain("<rect");
    });

    it("namespaces every state's ids under the run's prefix", () => {
      const { svg } = composeStatesFlipbook(trees, holds, 200, 120, "run7");
      expect(svg).toContain("@keyframes run7fb0");
      expect(svg).toContain(`<g id="run7fb2">`);
    });

    it("handles a two-state run (the minimum a collapse can produce)", () => {
      const { svg, durationMs } = composeStatesFlipbook([[], []], [250, 250], 200, 120, "cr");
      expect(durationMs).toBe(500);
      expect(svg).toContain("@keyframes crfb0{0%{display:inline}50%{display:none}100%{display:none}}");
      expect(svg).toContain("@keyframes crfb1{0%{display:none}50%{display:inline}100%{display:inline}}");
    });
  });
});

describe("compressMarkedRuns (DM-1761): the explicit per-frame `compress: true` marker", () => {
  const B = { width: 200, height: 120 };
  const cut = { type: "cut", duration: 0 } as const;
  const cross = { type: "crossfade", duration: 150 } as const;
  const cfgOf = (frames: unknown[], extra: Record<string, unknown> = {}) =>
    validateAnimateConfig({ ...B, ...extra, frames });
  /** Four frames that would ALL collapse under `autoCompress` — the contrast set.
   *  Typed loosely so a test can stamp `compress` onto a member without the
   *  inferred element union rejecting the extra key (`cfgOf` takes `unknown[]`). */
  const eligible4 = (): Record<string, unknown>[] => [
    { input: "a.html", duration: 100, transition: cut },
    { continue: true, duration: 100, transition: cut },
    { continue: true, duration: 100, transition: cut },
    { continue: true, duration: 100, transition: cut },
  ];

  it("is a no-op when no frame carries the marker (same object back)", () => {
    const cfg = cfgOf(eligible4());
    expect(compressMarkedRuns(cfg)).toBe(cfg);
  });

  it("collapses ONLY the marked run, leaving equally-eligible frames alone", () => {
    const frames = eligible4();
    frames[2] = { ...frames[2], compress: true };
    const cfg = cfgOf(frames);
    const out = compressMarkedRuns(cfg);
    // Frames 0 and 1 are just as eligible, but unmarked → untouched. Run [2,3]
    // collapses. This selectivity is the marker's whole reason to exist:
    // `autoCompress` on the SAME config would collapse all four into one.
    expect(out.frames).toHaveLength(3);
    expect(out.frames[0].states).toBeUndefined();
    expect(out.frames[1].states).toBeUndefined();
    expect(out.frames[2].states).toHaveLength(2);
    expect(out.frames[2].duration).toBe(200);
    expect(autoCompressRuns(cfgOf(eligible4(), { autoCompress: true })).frames).toHaveLength(1);
  });

  it("anchor-only: the marker takes the maximal run STARTING at that frame", () => {
    const frames = eligible4();
    frames[1] = { ...frames[1], compress: true };
    const out = compressMarkedRuns(cfgOf(frames));
    expect(out.frames).toHaveLength(2);
    expect(out.frames[0].input).toBe("a.html");
    expect(out.frames[1].continue).toBe(true);
    expect(out.frames[1].states).toHaveLength(3);
    expect(out.frames[1].duration).toBe(300);
  });

  it("markers on later members of the same run are redundant no-ops", () => {
    const anchorOnly = eligible4();
    anchorOnly[1] = { ...anchorOnly[1], compress: true };
    const everyMember = eligible4().map((f, i) => (i >= 1 ? { ...f, compress: true } : f));
    // Both styles must produce the identical rewrite — the greedy left-to-right
    // scan consumes 2 and 3 into the run seeded at 1, so their markers can never
    // seed a second, overlapping run.
    expect(compressMarkedRuns(cfgOf(everyMember)).frames).toEqual(compressMarkedRuns(cfgOf(anchorOnly)).frames);
  });

  it("carries the anchor's actions / readiness wait onto the collapsed frame", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut, waitFor: ".ready", compress: true, actions: [{ type: "evaluate", script: "s(0)" }] },
      { continue: true, duration: 120, transition: cut, actions: [{ type: "evaluate", script: "s(1)" }] },
    ]);
    const out = compressMarkedRuns(cfg);
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0].waitFor).toBe(".ready");
    expect(out.frames[0].actions).toEqual([{ type: "evaluate", script: "s(0)" }]);
    expect(out.frames[0].states).toEqual([
      { duration: 100 },
      { actions: [{ type: "evaluate", script: "s(1)" }], duration: 120 },
    ]);
  });

  // The hard-error contract: an explicit marker that cannot be honored FAILS,
  // where `autoCompress` would silently log and skip. One case per reason.
  const errorCases: Array<{ name: string; frames: unknown[]; extra?: Record<string, unknown>; match: RegExp }> = [
    {
      name: "the anchor leaves via a non-cut transition",
      frames: [
        { input: "a.html", duration: 100, transition: cross, compress: true },
        { continue: true, duration: 100, transition: cut },
      ],
      match: /frames\[0\].*`crossfade` transition, not a `cut`/,
    },
    {
      name: "the anchor carries overlays (points at the `states:` block)",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true, overlays: [{ kind: "typing", text: "x", x: 0, y: 0 }] },
        { continue: true, duration: 100, transition: cut },
      ],
      match: /frames\[0\] carries `overlays`.*`states:` block/,
    },
    {
      name: "a member carries animations",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut, animations: [{ selector: "#a", property: "opacity", from: "0", to: "1", duration: 100 }] },
      ],
      match: /no following frame can join it — frames\[1\] carries `animations`/,
    },
    {
      name: "a member carries textTracks",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut, textTracks: [{ selector: "#a", events: [{ at: 0, type: "park", charOffset: 0 }] }] },
      ],
      match: /frames\[1\] carries `textTracks`/,
    },
    {
      name: "the anchor is a content-producing frame kind",
      frames: [
        { cast: "a.cast", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut },
      ],
      match: /frames\[0\] is a `cast` frame, which produces its own nested content/,
    },
    {
      name: "the marker rides a frame that already IS a compressed run",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true, states: [{ duration: 50 }, { duration: 50 }] },
        { continue: true, duration: 100, transition: cut },
      ],
      match: /frames\[0\] already IS a compressed run.*drop the `compress` marker/,
    },
    {
      name: "the anchor captures a selector subtree",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true, selector: "#card" },
        { continue: true, duration: 100, transition: cut },
      ],
      match: /frames\[0\] captures a `selector` subtree/,
    },
    {
      name: "the marked frame is last",
      frames: [
        { input: "a.html", duration: 100, transition: cut },
        { continue: true, duration: 100, transition: cut, compress: true },
      ],
      match: /frames\[1\].*last frame in the config/,
    },
    {
      name: "the next frame reloads an input",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { input: "b.html", duration: 100, transition: cut },
      ],
      match: /frames\[1\] loads an `input` \(a compressed run holds ONE continuous page\)/,
    },
    {
      name: "a member carries a readiness wait",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut, waitFor: ".ready" },
      ],
      match: /frames\[1\] carries a readiness wait/,
    },
    {
      name: "an explicit cursor event addresses a member",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut },
      ],
      extra: { cursor: { events: [{ frame: 1, at: 0, type: "click", selector: "#b" }] } },
      match: /an explicit cursor event addresses frame 1 inside it/,
    },
    {
      name: "the run is entered via a magic-move transition",
      frames: [
        { input: "a.html", duration: 100, transition: { type: "magic-move", duration: 300 } },
        { continue: true, duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut },
      ],
      match: /frames\[1\].*entered via a magic-move transition/,
    },
    {
      name: "cursor:auto would derive a pointer from a member's interaction action",
      frames: [
        { input: "a.html", duration: 100, transition: cut, compress: true },
        { continue: true, duration: 100, transition: cut, actions: [{ type: "click", selector: "#b" }] },
      ],
      extra: { cursor: "auto" },
      match: /cursor:"auto" derives a pointer from an interaction action in frame 1/,
    },
  ];
  for (const c of errorCases) {
    it(`hard-errors when ${c.name}`, () => {
      const cfg = cfgOf(c.frames, c.extra ?? {});
      expect(() => compressMarkedRuns(cfg)).toThrow(c.match);
      // The same config under `autoCompress` only logs and skips — the contrast
      // that justifies the marker's stricter contract.
      const logs: string[] = [];
      expect(() => autoCompressRuns(validateAnimateConfig({ ...B, ...(c.extra ?? {}), autoCompress: true, frames: c.frames }), (m) => logs.push(m))).not.toThrow();
    });
  }

  it("`compress: false` opts a frame out of an automatic run", () => {
    const frames = eligible4();
    frames[2] = { ...frames[2], compress: false };
    const out = autoCompressRuns(cfgOf(frames, { autoCompress: true }));
    // Run [0,1] collapses; frame 2 is excluded outright; frame 3 is alone. 4 → 3.
    expect(out.frames).toHaveLength(3);
    expect(out.frames[0].states).toHaveLength(2);
    expect(out.frames[1].compress).toBe(false);
    expect(out.frames[1].states).toBeUndefined();
    expect(out.frames[2].states).toBeUndefined();
  });

  it("composes with autoCompress: the marked run collapses first, then the rest — no double-collapse", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },                    // auto run A
      { continue: true, duration: 100, transition: cut },                     // auto run A
      { continue: true, duration: 100, transition: cross },                   // standalone
      { continue: true, duration: 100, transition: cut, compress: true },     // marked run B
      { continue: true, duration: 100, transition: cut },                     // marked run B
    ], { autoCompress: true });
    const marked = compressMarkedRuns(cfg);
    expect(marked.frames).toHaveLength(4);      // [3,4] → one states frame
    expect(marked.frames[3].states).toHaveLength(2);
    const both = autoCompressRuns(marked);
    // Run A collapses on the automatic pass; the already-collapsed run B carries
    // `states`, which disqualifies it as anchor AND member — collapsed once only.
    expect(both.frames).toHaveLength(3);
    expect(both.frames[0].states).toHaveLength(2);
    expect(both.frames[1].states).toBeUndefined();
    expect(both.frames[2].states).toHaveLength(2);
    expect(both.frames[2].duration).toBe(200);
  });

  it("remaps explicit cursor-event frame indices across a marked collapse", () => {
    const cfg = cfgOf([
      { input: "a.html", duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cut, compress: true }, // run [1,2]
      { continue: true, duration: 100, transition: cut },
      { continue: true, duration: 100, transition: cross },
    ], { cursor: { events: [{ frame: 3, at: 0, type: "click", selector: "#c" }] } });
    const out = compressMarkedRuns(cfg);
    expect(out.frames).toHaveLength(3); // 0→0, [1,2]→1, 3→2
    if (out.cursor != null && out.cursor !== "auto") {
      expect(out.cursor.events[0].frame).toBe(2);
    } else {
      throw new Error("expected an explicit cursor event list");
    }
  });

  it("logs the collapse with the `compress:` tag (not `auto-compress:`)", () => {
    const frames = eligible4();
    frames[1] = { ...frames[1], compress: true };
    const logs: string[] = [];
    compressMarkedRuns(cfgOf(frames), (m) => logs.push(m));
    expect(logs.some((l) => /^ {2}compress: collapsed frames 1–3 into a states run \(3 states, 300ms\)$/.test(l))).toBe(true);
    expect(logs.some((l) => /auto-compress:/.test(l))).toBe(false);
  });
});
