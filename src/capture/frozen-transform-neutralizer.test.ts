import { describe, expect, it } from "vitest";

import { frozenTransformPredicateSource } from "./frozen-transform-neutralizer.js";
import { transformFreezes } from "./script/walker/transforms.js";

type StyleFixture = Partial<
  Pick<
    CSSStyleDeclaration,
    "transform" | "translate" | "rotate" | "scale" | "transitionProperty" | "transitionDuration" | "transitionDelay"
  >
>;

function style(fixture: StyleFixture): CSSStyleDeclaration {
  return {
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    transitionProperty: "all",
    transitionDuration: "0s",
    transitionDelay: "0s",
    ...fixture,
  } as CSSStyleDeclaration;
}

function element(keyframes: Array<Record<string, unknown>> = [], playState = "running"): Element {
  return {
    getAnimations: () =>
      keyframes.length === 0 ? [] : [{ playState, effect: { getKeyframes: () => keyframes } } as unknown as Animation],
  } as unknown as Element;
}

// The page-side copy is rebuilt from the walker's own function sources; this
// evaluates it the way the page does and requires the same answer.
const shipped = new Function(`${frozenTransformPredicateSource()}\nreturn transformFreezes;`)() as (
  el: Element,
  cs: CSSStyleDeclaration,
) => boolean;

const cases: Array<[string, Element, CSSStyleDeclaration, boolean]> = [
  ["untransformed", element(), style({}), false],
  ["fractional translate", element(), style({ transform: "matrix(1, 0, 0, 1, -0.5, -0.5)" }), true],
  ["scale", element(), style({ transform: "matrix(1.5, 0, 0, 1.5, 0, 0)" }), true],
  ["rotation", element(), style({ transform: "matrix(0.98, 0.17, -0.17, 0.98, 0, 0)" }), true],
  [
    "affine matrix3d",
    element(),
    style({ transform: "matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)" }),
    true,
  ],
  [
    "translateZ stays live",
    element(),
    style({ transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1)" }),
    false,
  ],
  [
    "perspective stays live",
    element(),
    style({ transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, -0.01, 0, 0, 1, 0, 0, 0, 0, 1)" }),
    false,
  ],
  [
    "declared transform transition stays live",
    element(),
    style({ transform: "matrix(1, 0, 0, 1, 4, 0)", transitionProperty: "transform", transitionDuration: "0.3s" }),
    false,
  ],
  [
    "zero-length transition freezes",
    element(),
    style({ transform: "matrix(1, 0, 0, 1, 4, 0)", transitionProperty: "transform", transitionDuration: "0s" }),
    true,
  ],
  [
    "unrelated transition freezes",
    element(),
    style({ transform: "matrix(1, 0, 0, 1, 4, 0)", transitionProperty: "opacity", transitionDuration: "1s" }),
    true,
  ],
  [
    "running transform animation stays live",
    element([{ transform: "translateX(0px)" }, { transform: "translateX(10px)" }]),
    style({ transform: "matrix(1, 0, 0, 1, 4, 0)" }),
    false,
  ],
  [
    "finished transform animation freezes",
    element([{ transform: "translateX(0px)" }], "finished"),
    style({ transform: "matrix(1, 0, 0, 1, 4, 0)" }),
    true,
  ],
  [
    "animated rotation still freezes",
    element([{ transform: "rotate(0deg)" }]),
    style({ transform: "matrix(0.98, 0.17, -0.17, 0.98, 0, 0)" }),
    true,
  ],
];

describe("frozen-transform neutralizer predicate", () => {
  it.each(cases)("%s", (_name, el, cs, expected) => {
    expect(transformFreezes(el, cs)).toBe(expected);
    expect(shipped(el, cs)).toBe(expected);
  });
});
