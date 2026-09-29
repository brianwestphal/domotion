import { describe, expect, it } from "vitest";
import { withRenderTextMode, getRenderTextMode } from "./font-resolution.js";
import {
  visualTextOnlyHiddenAttr,
  visualTextSemantics,
  withTextEngineVisualSemanticsSuppressed,
} from "./text-semantics.js";

const HIDDEN = ` aria-hidden="true"`;

describe("visual-semantics suppression depth", () => {
  it("is off by default and labels the run", () => {
    expect(visualTextOnlyHiddenAttr()).toBe("");
    expect(visualTextSemantics("hi")).toEqual({ attrs: ` role="img" aria-label="hi"`, title: "<title>hi</title>" });
  });

  it("stays suppressed until the OUTERMOST scope exits (depth 2 → 1 → 0)", () => {
    withTextEngineVisualSemanticsSuppressed(() => {
      withTextEngineVisualSemanticsSuppressed(() => expect(visualTextOnlyHiddenAttr()).toBe(HIDDEN));
      expect(visualTextOnlyHiddenAttr()).toBe(HIDDEN);
      expect(visualTextSemantics("x")).toEqual({ attrs: HIDDEN, title: "" });
    });
    expect(visualTextOnlyHiddenAttr()).toBe("");
  });

  it("restores the depth after a throw, including a throw from an inner scope", () => {
    expect(() =>
      withTextEngineVisualSemanticsSuppressed(() =>
        withTextEngineVisualSemanticsSuppressed(() => {
          throw new Error("stop");
        }),
      ),
    ).toThrow("stop");
    expect(visualTextOnlyHiddenAttr()).toBe("");
    // A later scope starts from zero, not from a leaked depth.
    withTextEngineVisualSemanticsSuppressed(() => undefined);
    expect(visualTextOnlyHiddenAttr()).toBe("");
  });

  it("is independent of the render-text-mode scope in either nesting order", () => {
    const before = getRenderTextMode();
    withTextEngineVisualSemanticsSuppressed(() =>
      withRenderTextMode("paths", () => {
        expect(visualTextOnlyHiddenAttr()).toBe(HIDDEN);
        expect(getRenderTextMode()).toBe("paths");
      }),
    );
    withRenderTextMode("paths", () =>
      withTextEngineVisualSemanticsSuppressed(() => {
        expect(visualTextOnlyHiddenAttr()).toBe(HIDDEN);
      }),
    );
    expect(visualTextOnlyHiddenAttr()).toBe("");
    expect(getRenderTextMode()).toBe(before);
  });

  it("a throw escaping the mode scope still unwinds the suppression scope", () => {
    expect(() =>
      withTextEngineVisualSemanticsSuppressed(() =>
        withRenderTextMode("paths", () => {
          throw new Error("stop");
        }),
      ),
    ).toThrow("stop");
    expect(visualTextOnlyHiddenAttr()).toBe("");
  });
});
