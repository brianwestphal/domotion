/**
 * DM-1564 (docs/94 option 3): unit coverage for the pure `jsReveal` spec
 * defaulting. The browser-driven MutationObserver harness (`detectJsMutations` /
 * `buildJsRevealAnimation`) is covered by `mutation-detect.e2e.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { resolveJsRevealSpec, JS_REVEAL_DEFAULTS, MUTATION_DETECT_EVENTS } from "./mutation-detect.js";

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
