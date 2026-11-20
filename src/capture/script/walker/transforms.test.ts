import { describe, expect, it } from "vitest";

import {
  neutralizeTransformForFreeze,
  resolveTranslateComponent,
  transformReferenceBox,
  transformWrapsAsAffine2D,
  zoomTransformOrigin,
  zoomTransformTranslation,
} from "./transforms.js";

function computed(fields: Record<string, string>): CSSStyleDeclaration {
  return {
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    width: "0px",
    height: "0px",
    boxSizing: "content-box",
    paddingLeft: "0px",
    paddingRight: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    ...fields,
  } as unknown as CSSStyleDeclaration;
}

describe("translate longhand resolution", () => {
  it("resolves lengths, percentages of the reference box, and calc() sums", () => {
    expect(resolveTranslateComponent("8px", 200)).toBe(8);
    expect(resolveTranslateComponent("-50%", 200)).toBe(-100);
    expect(resolveTranslateComponent("calc(50% + 8px)", 200)).toBe(108);
    expect(resolveTranslateComponent("calc(-25% - 2.5px)", 40)).toBe(-12.5);
    expect(resolveTranslateComponent("0px", 0)).toBe(0);
    expect(resolveTranslateComponent("garbage", 10)).toBe(0);
  });

  it("measures the border box as the reference box", () => {
    const style = computed({
      width: "100px",
      height: "20px",
      paddingLeft: "10px",
      paddingRight: "10px",
      paddingTop: "4px",
      paddingBottom: "4px",
      borderLeftWidth: "1px",
      borderRightWidth: "1px",
      borderTopWidth: "1px",
      borderBottomWidth: "1px",
    });
    expect(transformReferenceBox(style)).toEqual({ width: 122, height: 30 });
    expect(transformReferenceBox({ ...style, boxSizing: "border-box" } as CSSStyleDeclaration)).toEqual({
      width: 100,
      height: 20,
    });
  });
});

describe("transformWrapsAsAffine2D", () => {
  it("accepts planar affine matrices and rejects projective or translateZ ones", () => {
    expect(transformWrapsAsAffine2D("none")).toBe(false);
    expect(transformWrapsAsAffine2D("matrix(1, 0, 0, 1, 0.5, 0.5)")).toBe(true);
    expect(transformWrapsAsAffine2D("matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1)")).toBe(true);
    expect(transformWrapsAsAffine2D("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)")).toBe(false);
    expect(transformWrapsAsAffine2D("matrix3d(1, 0, 0, 0, 0, 1, 0, -0.01, 0, 0, 1, 0, 0, 0, 0, 1)")).toBe(false);
  });
});

describe("effective zoom on a frozen transform", () => {
  it("scales only the matrix translation, as AffineTransform::Zoom does", () => {
    expect(zoomTransformTranslation("matrix(1.5, 0, 0, 1.5, 17, 9)", 1.25)).toBe(
      "matrix(1.5, 0, 0, 1.5, 21.25, 11.25)",
    );
    expect(zoomTransformTranslation("matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)", 0.5)).toBe(
      "matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 10, 0, 1)",
    );
    expect(zoomTransformTranslation("matrix(1, 0, 0, 1, 17, 9)", 1)).toBe("matrix(1, 0, 0, 1, 17, 9)");
    expect(zoomTransformTranslation("none", 2)).toBe("none");
  });

  it("scales a resolved px origin and leaves anything else alone", () => {
    expect(zoomTransformOrigin("7.5px 3.25px", 1.25)).toBe("9.375px 4.0625px");
    expect(zoomTransformOrigin("20px 12px 4px", 0.5)).toBe("10px 6px 2px");
    expect(zoomTransformOrigin("7.5px 3.25px", 1)).toBe("7.5px 3.25px");
    expect(zoomTransformOrigin("50% 50%", 2)).toBe("50% 50%");
  });
});

// A fake of the Web Animations and style surface the helper touches. Its
// computed style follows Blink's cascade for these cases: an inline
// `!important` value wins, then an author `!important` value, then a held
// override animation, then a transition whose effect is attached, then the
// author value.
function fakeOwner(author: Record<string, string>, options: { important?: boolean; transition?: boolean } = {}) {
  const inline = new Map<string, { value: string; priority: string }>();
  let styleAttribute: string | null = null;
  const events: string[] = [];
  const overrides: { identity: Record<string, string>; held: boolean }[] = [];
  const transitionEffect: { target: unknown } = { target: null };
  const transition = { transitionProperty: "rotate", playState: "running", effect: transitionEffect };
  const cssName = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const computedValue = (name: string): string => {
    const own = inline.get(name);
    if (own != null && own.priority === "important") return own.value;
    if (options.important && author[name] != null) return author[name];
    for (const override of overrides) {
      if (!override.held) continue;
      for (const [key, value] of Object.entries(override.identity))
        if (cssName(key) === name) return key === "transform" ? "matrix(1, 0, 0, 1, 0, 0)" : value;
    }
    if (name === "rotate" && options.transition && transitionEffect.target != null) return "12deg";
    return author[name] ?? (name === "transform-style" ? "flat" : "none");
  };
  class FakeKeyframeEffect {
    constructor(
      public target: unknown,
      public keyframes: Record<string, string>[],
    ) {}
  }
  class FakeAnimation {
    private entry: { identity: Record<string, string>; held: boolean };
    constructor(effect: FakeKeyframeEffect) {
      this.entry = { identity: effect.keyframes[0], held: false };
      overrides.push(this.entry);
    }
    set currentTime(_time: number) {
      this.entry.held = true;
    }
    cancel() {
      this.entry.held = false;
      events.push("override cancel");
    }
  }
  const view = {
    getComputedStyle: () => ({ getPropertyValue: computedValue }),
    KeyframeEffect: FakeKeyframeEffect,
    Animation: FakeAnimation,
  };
  const element = {
    ownerDocument: { defaultView: view, timeline: {} },
    getAnimations: () => (options.transition ? [transition] : []),
    getAttribute: () => styleAttribute,
    setAttribute: (_name: string, value: string) => (styleAttribute = value),
    removeAttribute: () => (styleAttribute = null),
    style: {
      setProperty(name: string, value: string, priority: string) {
        inline.set(name, { value, priority });
        styleAttribute = Array.from(inline, ([key, entry]) => `${key}: ${entry.value} !${entry.priority};`).join(" ");
      },
      set cssText(_text: string) {
        inline.clear();
      },
    },
  };
  transitionEffect.target = element;
  return {
    element: element as unknown as HTMLElement,
    computedValue,
    inline,
    events,
    transitionEffect,
    styleAttribute: () => styleAttribute,
  };
}

describe("neutralizeTransformForFreeze", () => {
  it("holds the identity with an override animation and leaves the style attribute alone", () => {
    const owner = fakeOwner({ transform: "matrix(0.98, 0.17, -0.17, 0.98, 0, 0)" });
    const restore = neutralizeTransformForFreeze(owner.element);
    expect(owner.computedValue("transform")).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(owner.inline.size).toBe(0);
    restore();
    expect(owner.computedValue("transform")).toBe("matrix(0.98, 0.17, -0.17, 0.98, 0, 0)");
    expect(owner.styleAttribute()).toBeNull();
    expect(owner.events).toEqual(["override cancel"]);
  });

  it("detaches a running transition for the window and reattaches it", () => {
    const owner = fakeOwner({ rotate: "20deg" }, { transition: true });
    expect(owner.computedValue("rotate")).toBe("12deg");
    const restore = neutralizeTransformForFreeze(owner.element);
    expect(owner.transitionEffect.target).toBeNull();
    expect(owner.computedValue("rotate")).toBe("none");
    restore();
    expect(owner.transitionEffect.target).toBe(owner.element);
    expect(owner.computedValue("rotate")).toBe("12deg");
  });

  it("writes only the properties an author !important declaration keeps from the override", () => {
    const owner = fakeOwner({ transform: "matrix(0.98, 0.17, -0.17, 0.98, 0, 0)" }, { important: true });
    const restore = neutralizeTransformForFreeze(owner.element);
    expect(Array.from(owner.inline.keys())).toEqual(["transform"]);
    expect(owner.computedValue("transform")).toBe("translate(0)");
    restore();
    expect(owner.styleAttribute()).toBeNull();
    expect(owner.computedValue("transform")).toBe("matrix(0.98, 0.17, -0.17, 0.98, 0, 0)");
  });

  it("also flattens perspective and transform-style when asked", () => {
    const owner = fakeOwner({ perspective: "400px", "transform-style": "preserve-3d" });
    const restore = neutralizeTransformForFreeze(owner.element, true);
    expect(owner.computedValue("perspective")).toBe("none");
    expect(owner.computedValue("transform-style")).toBe("flat");
    expect(owner.inline.size).toBe(0);
    restore();
    expect(owner.computedValue("transform-style")).toBe("preserve-3d");
  });
});
