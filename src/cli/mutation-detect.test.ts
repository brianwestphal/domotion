/**
 * DM-1564 (docs/94 option 3): unit coverage for the pure `jsReveal` spec
 * defaulting. The browser-driven MutationObserver harness (`detectJsMutations` /
 * `buildJsRevealAnimation`) is covered by `mutation-detect.e2e.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { resolveJsRevealSpec, JS_REVEAL_DEFAULTS, MUTATION_DETECT_EVENTS, synthMutationTween } from "./mutation-detect.js";
import type { HoverDiff } from "./hover-detect.js";

describe("resolveJsRevealSpec (DM-1564)", () => {
  it("applies the documented defaults when only selector is given", () => {
    expect(resolveJsRevealSpec({ selector: "#menu" })).toEqual({
      selector: "#menu",
      event: JS_REVEAL_DEFAULTS.event,
      settleMs: JS_REVEAL_DEFAULTS.settleMs,
      debounceMs: JS_REVEAL_DEFAULTS.debounceMs,
      holdMs: JS_REVEAL_DEFAULTS.holdMs,
      crossfadeMs: JS_REVEAL_DEFAULTS.crossfadeMs,
    });
  });

  it("respects explicit overrides, including a zero crossfade", () => {
    const spec = resolveJsRevealSpec({
      selector: "#t", event: "mousedown", settleMs: 300, debounceMs: 50, holdMs: 400, crossfadeMs: 0,
    });
    expect(spec.event).toBe("mousedown");
    expect(spec.settleMs).toBe(300);
    expect(spec.debounceMs).toBe(50);
    expect(spec.holdMs).toBe(400);
    expect(spec.crossfadeMs).toBe(0);
  });

  it("defaults the event to mouseover (the most common JS hover trigger)", () => {
    expect(resolveJsRevealSpec({ selector: "#x" }).event).toBe("mouseover");
    expect(MUTATION_DETECT_EVENTS).toContain("mouseover");
  });
});

describe("synthMutationTween (DM-1580)", () => {
  const diff = (motion: HoverDiff["motion"]): HoverDiff => ({ paint: [], motion });

  it("builds a transform tween (with fused opacity) for a target motion delta", () => {
    const anims = synthMutationTween(diff([
      { key: "", property: "transform", from: "none", to: "scale(1.1)" },
      { key: "", property: "opacity", from: "1", to: "0.8" },
    ]), "jr0", 300);
    expect(anims).toHaveLength(1);
    expect(anims[0]).toMatchObject({ animId: "jr0", property: "transform", from: "none", to: "scale(1.1)", duration: 300, transformOrigin: "center" });
    expect(anims[0].fuse).toEqual([{ property: "opacity", from: "1", to: "0.8" }]);
  });

  it("builds an opacity-only tween when there's no transform delta", () => {
    const anims = synthMutationTween(diff([{ key: "", property: "opacity", from: "1", to: "0.5" }]), "jr0", 200);
    expect(anims).toEqual([{ animId: "jr0", property: "opacity", from: "1", to: "0.5", duration: 200, easing: "ease-out" }]);
  });

  it("returns nothing when the motion deltas aren't on the target (key !== '')", () => {
    expect(synthMutationTween(diff([{ key: "3", property: "transform", from: "none", to: "scale(2)" }]), "jr0", 300)).toEqual([]);
    expect(synthMutationTween(diff([]), "jr0", 300)).toEqual([]);
  });
});
