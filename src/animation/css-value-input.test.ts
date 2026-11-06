import { describe, expect, it } from "vitest";
import { generateAnimatedSvg, type AnimationFrame } from "./animator.js";
import { composeAnimatedLayers } from "./composite.js";
import {
  cssAnimationValueForStyle,
  cssIdentForStyle,
  cssValueForStyle,
  isAnimationValueInput,
  isSafeCssValue,
  type AnimationValueProperty,
} from "./css-value-input.js";
import { buildShineSweep } from "./shine.js";
import { resolveTextTrack, textTrackMarkup } from "./caret-track.js";
import type { CapturedElement } from "../capture/types.js";
import { cursorOverlayMarkup, resolveCursorScript } from "./cursor-overlay.js";
import {
  blinkOverlaySchema,
  interactOverlaySchema,
  intraFrameAnimationSchema,
  shineOverlaySchema,
  typingOverlaySchema,
} from "./overlay-schema.js";
import { transitionSchema } from "./transition-schema.js";
import { animateConfigSchema } from "../cli/animate-orchestrator.js";
import { compositeConfigSchema, compositeLayerAnimationSchema } from "../cli/composite.js";
import { storyboardConfigSchema } from "../cli/storyboard.js";
import { terminalThemeSpecSchema } from "../terminal/theme.js";
import { brandSchema } from "../templates/brand.js";
import { chatParamsSchema } from "../templates/builtin/chat.js";
import { chartParamsSchema } from "../templates/builtin/chart.js";
import { backgroundLoopParamsSchema } from "../templates/builtin/background-loop.js";

// DM-W7FHMJ: animation from/to/transformOrigin, overlay and caret colors, and
// canvas backgrounds used to be interpolated as free text into the output SVG's
// `<style>` block or a presentation attribute, so a value could close the element
// (`0}</style><script>…`) or the attribute (`red" onload="…`) and inject markup.
// Each config schema now rejects them, and every emission site re-checks for
// direct API callers. Sibling of easing-input.test.ts.

/** Hostile for every free-form CSS field. */
const HOSTILE_VALUES = [
  "0}</style><script>alert(1)</script><style>",
  "red; } .x { fill: red",
  'red" onload="alert(1)',
  "red' onload='alert(1)",
  "1</style>",
  "50% 50%;transform:none",
  "\\3c /style\\3e",
  "red&amp;",
  "red\nblue",
];
/** Hostile even where quotes are allowed (clip-path). */
const HOSTILE_QUOTED = HOSTILE_VALUES.filter((v) => !/^red['"]/.test(v));

const POSITIVE: Record<AnimationValueProperty, string[]> = {
  opacity: ["0", "1", "0.35", ".5", "50%", "var(--o)"],
  scale: ["1", "0.6", "2 3", "1, 2", "1.5 1.5 1"],
  translateX: ["0", "0px", "-1000px", "24px", "0.6em", "100%", "calc(100% - 20px)"],
  translateY: ["-7px", "0em", "-0.6em"],
  width: ["0%", "240px", "100%"],
  height: ["0", "48px"],
  transform: ["translate(0px, 0px)", "scale(0.3) rotate(-22deg)", "scaleX(0)", "none", "matrix(1, 0, 0, 1, 0, 0)"],
  clipPath: ["inset(0 100% 0 0)", "inset(-10% 0% -10% 0)", "path('M 0 0 L 10 10 Z')", 'url("#c")', "circle(50%)"],
  clipScaleX: ["0", "1", "0.5"],
  clipScaleY: ["0.25"],
};

/** Values that are plain CSS but the wrong grammar for the property. */
const WRONG_GRAMMAR: Partial<Record<AnimationValueProperty, string[]>> = {
  opacity: ["red", "1px", "translate(0)", ""],
  scale: ["big", "1 2 3 4", "1px"],
  translateX: ["left", "1 2", "translate(1px)"],
  width: ["auto-ish 1"],
  clipScaleX: ["1px"],
};

describe("isSafeCssValue / isAnimationValueInput (DM-W7FHMJ)", () => {
  it("accepts every value each property's grammar allows", () => {
    for (const [property, values] of Object.entries(POSITIVE) as [AnimationValueProperty, string[]][]) {
      for (const v of values) expect(isAnimationValueInput(property, v), `${property} ${v}`).toBe(true);
    }
    for (const v of ["#fff", "rgba(0, 0, 0, 0.4)", "hsl(200 50% 40%)", "transparent", "center", "left top"]) {
      expect(isSafeCssValue(v), v).toBe(true);
    }
    expect(isAnimationValueInput("translateX", 24)).toBe(true);
  });

  it("rejects the wrong grammar for a property", () => {
    for (const [property, values] of Object.entries(WRONG_GRAMMAR) as [AnimationValueProperty, string[]][]) {
      for (const v of values)
        expect(isAnimationValueInput(property, v), `${property} ${JSON.stringify(v)}`).toBe(false);
    }
    expect(isAnimationValueInput("opacity", Number.NaN)).toBe(false);
  });

  it.each(HOSTILE_VALUES)("rejects %j for every property and as a plain value", (value) => {
    expect(isSafeCssValue(value)).toBe(false);
    for (const property of Object.keys(POSITIVE) as AnimationValueProperty[]) {
      if (property === "clipPath" && !HOSTILE_QUOTED.includes(value)) continue;
      expect(isAnimationValueInput(property, value), property).toBe(false);
    }
  });

  it("clip-path accepts quotes but not breakout characters", () => {
    expect(isSafeCssValue("path('M0 0')", { allowQuotes: true })).toBe(true);
    for (const v of HOSTILE_QUOTED) expect(isAnimationValueInput("clipPath", v), v).toBe(false);
  });

  it("the guards return safe values unchanged and throw on hostile ones", () => {
    expect(cssValueForStyle("#fff", "color")).toBe("#fff");
    expect(cssAnimationValueForStyle("opacity", "0.5", "from")).toBe("0.5");
    expect(cssIdentForStyle("f0a1", "animId")).toBe("f0a1");
    for (const v of HOSTILE_VALUES) {
      expect(() => cssValueForStyle(v, "color")).toThrow(/Invalid color/);
      expect(() => cssAnimationValueForStyle("transform", v, "from")).toThrow(/Invalid from/);
    }
    for (const v of ["a b", "x}", "a</style>", "", "a.b"]) expect(() => cssIdentForStyle(v, "animId")).toThrow();
  });
});

describe("config schemas reject hostile CSS values (DM-W7FHMJ)", () => {
  const canvas = { width: 100, height: 100 };
  const animFrame = (animation: Record<string, unknown>) =>
    animateConfigSchema.safeParse({
      ...canvas,
      frames: [{ input: "page.html", duration: 1000, animations: [{ selector: ".a", duration: 300, ...animation }] }],
    }).success;
  const cursorConfig = (pulseColor: string) =>
    animateConfigSchema.safeParse({
      ...canvas,
      frames: [{ input: "page.html", duration: 1 }],
      cursor: { events: [{ frame: 0, type: "move", to: { x: 0, y: 0 } }], style: { pulseColor } },
    }).success;
  const layerAnim = (animation: Record<string, unknown>) =>
    compositeLayerAnimationSchema.safeParse({ duration: 300, ...animation }).success;

  it("accepts legitimate values (positive controls)", () => {
    for (const [property, values] of Object.entries(POSITIVE) as [AnimationValueProperty, string[]][]) {
      if (property === "clipScaleX" || property === "clipScaleY") continue;
      for (const v of values) {
        expect(animFrame({ property, from: v, to: v }), `${property} ${v}`).toBe(true);
        expect(
          intraFrameAnimationSchema.safeParse({ animId: "a", property, from: v, to: v, duration: 1 }).success,
        ).toBe(true);
      }
    }
    expect(animFrame({ property: "scale", from: "0.6", to: "1", transformOrigin: "50% 50%" })).toBe(true);
    expect(animFrame({ preset: "fade-up" })).toBe(true);
    expect(
      animFrame({
        property: "translateY",
        from: "8px",
        to: "0px",
        fuse: [{ property: "opacity", from: "0", to: "1" }],
      }),
    ).toBe(true);
    for (const property of ["scale", "translateX", "opacity", "transform", "clipScaleX"]) {
      expect(layerAnim({ property, from: 0, to: 1 }), property).toBe(true);
    }
    expect(layerAnim({ property: "translateX", from: "0px", to: "-40px", transformOrigin: "center" })).toBe(true);
    expect(compositeConfigSchema.shape.background.safeParse("#0b1020").success).toBe(true);
  });

  it("rejects a value in the wrong grammar for its property", () => {
    expect(animFrame({ property: "opacity", from: "red", to: "1" })).toBe(false);
    expect(animFrame({ property: "translateX", from: "0px", to: "left" })).toBe(false);
    expect(
      animFrame({
        property: "translateY",
        from: "8px",
        to: "0px",
        fuse: [{ property: "opacity", from: "0", to: "1px" }],
      }),
    ).toBe(false);
    expect(layerAnim({ property: "scale", from: "huge", to: 1 })).toBe(false);
  });

  it.each(HOSTILE_VALUES)("rejects %j in every schema", (value) => {
    // Intra-frame animation (runtime schema + animate authoring form), every field.
    for (const property of ["opacity", "transform", "translateX", "scale", "width"]) {
      expect(animFrame({ property, from: value, to: "0" }), `${property} from`).toBe(false);
      expect(animFrame({ property, from: "0", to: value }), `${property} to`).toBe(false);
    }
    // The runtime schema checks the characters (quotes are allowed for clip-path);
    // the per-property grammar is enforced by the authoring schema and the emitter.
    expect(
      intraFrameAnimationSchema.safeParse({ animId: "a", property: "opacity", from: value, to: "1", duration: 1 })
        .success,
    ).toBe(!HOSTILE_QUOTED.includes(value));
    expect(animFrame({ property: "scale", from: "0", to: "1", transformOrigin: value })).toBe(false);
    expect(
      animFrame({
        property: "translateY",
        from: "0px",
        to: "1px",
        fuse: [{ property: "transform", from: value, to: "none" }],
      }),
    ).toBe(false);
    // Composite layer animations.
    expect(layerAnim({ property: "transform", from: value, to: "none" })).toBe(false);
    expect(layerAnim({ property: "opacity", from: 0, to: value })).toBe(false);
    expect(layerAnim({ property: "scale", from: 0, to: 1, transformOrigin: value })).toBe(false);
    // Colors and backgrounds that land in presentation attributes.
    expect(compositeConfigSchema.shape.background.safeParse(value).success).toBe(false);
    expect(storyboardConfigSchema.shape.background.safeParse(value).success).toBe(false);
    expect(typingOverlaySchema.safeParse({ kind: "typing", text: "a", x: 0, y: 0, color: value }).success).toBe(false);
    expect(typingOverlaySchema.safeParse({ kind: "typing", text: "a", x: 0, y: 0, bgColor: value }).success).toBe(
      false,
    );
    expect(
      typingOverlaySchema.safeParse({ kind: "typing", text: "a", x: 0, y: 0, caret: { color: value } }).success,
    ).toBe(false);
    expect(
      typingOverlaySchema.safeParse({ kind: "typing", text: "a", x: 0, y: 0, mask: { color: value } }).success,
    ).toBe(false);
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(blinkOverlaySchema.safeParse({ kind: "blink", ...box, color: value }).success).toBe(false);
    expect(shineOverlaySchema.safeParse({ kind: "shine", ...box, color: value }).success).toBe(false);
    expect(interactOverlaySchema.safeParse({ kind: "interact", ...box, fill: value }).success).toBe(false);
    expect(interactOverlaySchema.safeParse({ kind: "interact", ...box, ring: value }).success).toBe(false);
    expect(transitionSchema.safeParse({ type: "shine", duration: 300, shine: { color: value } }).success).toBe(false);
    expect(cursorConfig(value)).toBe(false);
    expect(terminalThemeSpecSchema.safeParse({ bg: value }).success).toBe(false);
    // Template / brand params that land in a generated page's `<style>` or attributes.
    if (/[{}<>\n]/.test(value)) {
      expect(chatParamsSchema.safeParse({ themBubble: value }).success).toBe(false);
      expect(brandSchema.safeParse({ palette: { primary: value } }).success).toBe(false);
      expect(brandSchema.safeParse({ font: { family: value } }).success).toBe(false);
    }
    expect(chartParamsSchema.safeParse({ data: [1, 2], colors: [value] }).success).toBe(false);
    expect(backgroundLoopParamsSchema.safeParse({ colors: [value] }).success).toBe(false);
  });

  it("positive controls for the color schemas", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(cursorConfig("rgba(0, 0, 0, 0.4)")).toBe(true);
    expect(storyboardConfigSchema.shape.background.safeParse("#0b1020").success).toBe(true);
    expect(blinkOverlaySchema.safeParse({ kind: "blink", ...box, color: "#ff0" }).success).toBe(true);
    expect(shineOverlaySchema.safeParse({ kind: "shine", ...box, color: "#fff" }).success).toBe(true);
    expect(
      typingOverlaySchema.safeParse({
        kind: "typing",
        text: "a",
        x: 0,
        y: 0,
        bgColor: "#fff",
        caret: { color: "#111" },
        mask: { color: "white" },
      }).success,
    ).toBe(true);
    expect(typingOverlaySchema.safeParse({ kind: "typing", text: "a", x: 0, y: 0, color: "#e6edf3" }).success).toBe(
      true,
    );
    expect(interactOverlaySchema.safeParse({ kind: "interact", ...box, fill: "none", ring: "#4c9ffe" }).success).toBe(
      true,
    );
    expect(
      transitionSchema.safeParse({ type: "shine", duration: 300, shine: { color: "rgba(255,255,255,0.8)" } }).success,
    ).toBe(true);
    expect(terminalThemeSpecSchema.safeParse({ bg: "#0d1117", fg: "rgb(230, 237, 243)" }).success).toBe(true);
    expect(chatParamsSchema.safeParse({ themBubble: "#e9e9eb" }).success).toBe(true);
    expect(chartParamsSchema.safeParse({ data: [1, 2], colors: "#3b82f6, #22c55e" }).success).toBe(true);
    expect(backgroundLoopParamsSchema.safeParse({ colors: ["#7c3aed", "hsl(200 80% 50%)"] }).success).toBe(true);
    expect(
      brandSchema.safeParse({ palette: { primary: "#3b82f6" }, font: { family: '"Inter", sans-serif' } }).success,
    ).toBe(true);
  });
});

describe("emission sites refuse hostile CSS values from direct API callers (DM-W7FHMJ)", () => {
  const frame = (extra: Partial<AnimationFrame>): AnimationFrame => ({
    svgContent: `<rect class="anim-a"/>`,
    duration: 1000,
    ...extra,
  });
  const render = (extra: Partial<AnimationFrame>, config: Record<string, unknown> = {}) =>
    generateAnimatedSvg({ width: 100, height: 100, frames: [frame(extra)], ...config });
  const HOSTILE = "0}</style><script>alert(1)</script><style>";

  it("intra-frame animation: from / to / fuse / transformOrigin / animId", () => {
    const base = { animId: "a", property: "opacity" as const, from: "0", to: "1", duration: 300 };
    const ok = render({
      animations: [{ ...base, transformOrigin: "center", fuse: [{ property: "scale", from: "0.6", to: "1" }] }],
    });
    expect(ok).toContain("transform-origin: center");
    expect(ok).toMatch(/@keyframes f0-a-0/);
    expect(() => render({ animations: [{ ...base, from: HOSTILE }] })).toThrow(/Invalid "opacity" animation from/);
    expect(() => render({ animations: [{ ...base, to: "red" }] })).toThrow(/Invalid "opacity" animation to/);
    expect(() => render({ animations: [{ ...base, property: "transform", from: HOSTILE }] })).toThrow(/Invalid/);
    expect(() =>
      render({ animations: [{ ...base, fuse: [{ property: "transform", from: "none", to: HOSTILE }] }] }),
    ).toThrow(/Invalid "transform" animation to/);
    // The sampled (independent-timing) path reads the same validated tracks.
    expect(() =>
      render({ animations: [{ ...base, fuse: [{ property: "transform", from: HOSTILE, to: "none", delay: 50 }] }] }),
    ).toThrow(/Invalid/);
    expect(() => render({ animations: [{ ...base, transformOrigin: HOSTILE }] })).toThrow(
      /Invalid animation transformOrigin/,
    );
    expect(() => render({ animations: [{ ...base, animId: "a{}" }] })).toThrow(/Invalid animation animId/);
    expect(() => render({ animations: [{ ...base, repeat: "infinite", from: HOSTILE }] })).toThrow(/Invalid/);
  });

  it("canvas background and overlay colors", () => {
    expect(render({}, { background: "#0b1020" })).toContain('fill="#0b1020"');
    expect(() => render({}, { background: 'red" onload="x' })).toThrow(/Invalid background/);
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(render({ overlays: [{ kind: "blink", ...box, color: "#ff0" }] })).toContain('fill="#ff0"');
    expect(() => render({ overlays: [{ kind: "blink", ...box, color: HOSTILE }] })).toThrow(/Invalid overlay color/);
    expect(render({ overlays: [{ kind: "interact", ...box, fill: "#fff", ring: "#4c9ffe" }] })).toContain(
      'stroke="#4c9ffe"',
    );
    expect(() => render({ overlays: [{ kind: "interact", ...box, fill: HOSTILE }] })).toThrow(/interact overlay fill/);
    expect(() => render({ overlays: [{ kind: "interact", ...box, ring: HOSTILE }] })).toThrow(/interact overlay ring/);
    expect(() => render({ overlays: [{ kind: "shine", ...box, color: HOSTILE }] })).toThrow(/Invalid shine color/);
    expect(() => render({ overlays: [{ kind: "typing", text: "a", x: 0, y: 10, color: HOSTILE }] })).toThrow(
      /Invalid overlay color/,
    );
    expect(() => render({ overlays: [{ kind: "svg", innerSvg: "<rect/>", ...box, animId: "x}</style>" }] })).toThrow(
      /Invalid svg overlay animId/,
    );
  });

  it("shine sweep stop-color", () => {
    const opts = { x: 0, y: 0, width: 100, height: 20, id: "s", startPct: 0, endPct: 50, totalSec: 1 };
    expect(buildShineSweep({ ...opts, color: "#fff" }).markup).toContain('stop-color="#fff"');
    expect(() => buildShineSweep({ ...opts, color: 'x" onload="y' })).toThrow(/Invalid shine color/);
  });

  it("text-track caret and selection fill", () => {
    const roots = [
      {
        tag: "div",
        text: "",
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        children: [],
        styles: { fontSize: "16px", fontFamily: "Helvetica, sans-serif", fontWeight: "400" },
        animId: "line",
        fontAscent: 12,
        fontDescent: 4,
        textSegments: [{ text: "abcd", x: 10, y: 100, width: 40, height: 18, xOffsets: [10, 20, 30, 40] }],
      },
    ] as unknown as CapturedElement[];
    const track = (color?: string, selectionColor?: string) =>
      resolveTextTrack(roots, {
        target: { animId: "line" },
        color,
        selectionColor,
        events: [
          { type: "park", t: 0, charOffset: 0 },
          { type: "select", t: 100, charStart: 0, charEnd: 2 },
        ],
      });
    expect(textTrackMarkup(track("#222", "#abc"), 1000)).toContain('fill="#222"');
    expect(() => track('x" onload="y')).toThrow(/Invalid text track color/);
    expect(() => track(undefined, "x}</style>")).toThrow(/Invalid text track selection color/);
  });

  it("cursor click-pulse stroke", () => {
    const script = (pulseStroke: string) =>
      resolveCursorScript(
        {
          events: [
            { type: "show", t: 0, x: 5, y: 5 },
            { type: "click", t: 100, button: "primary" },
          ],
          style: { pulseStroke },
        },
        1000,
        [0],
        null,
      );
    const ok = script("#123456");
    expect(cursorOverlayMarkup(ok.positions, ok.clicks, ok.style, 1000)).toContain('stroke="#123456"');
    const bad = script('x"/><script>alert(1)</script>');
    expect(() => cursorOverlayMarkup(bad.positions, bad.clicks, bad.style, 1000)).toThrow(/Invalid cursor pulse color/);
  });

  it("composite layer animations and background", () => {
    const layer = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg>`;
    const compose = (animation: Record<string, unknown>, background?: string) =>
      composeAnimatedLayers(
        [
          {
            svg: layer,
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            animations: [{ property: "translateX", from: "0px", to: "10px", duration: 500, ...animation }],
          },
        ],
        { width: 100, height: 50, durationMs: 1000, background },
      ).svg;
    const ok = compose({ transformOrigin: "center" }, "#111");
    expect(ok).toContain("transform-origin:center");
    expect(ok).toContain('fill="#111"');
    expect(() => compose({ from: HOSTILE })).toThrow(/Invalid "translateX" layer animation from/);
    expect(() => compose({ property: "transform", to: HOSTILE })).toThrow(/Invalid "transform" layer animation to/);
    expect(() => compose({ property: "opacity", from: "red", to: "1" })).toThrow(/Invalid "opacity"/);
    expect(() => compose({ transformOrigin: '0 0;" onload="x' })).toThrow(/layer animation transformOrigin/);
    expect(() => compose({}, 'red"/><script>alert(1)</script>')).toThrow(/Invalid composite background/);
  });
});
