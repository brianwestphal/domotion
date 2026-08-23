import { describe, expect, it } from "vitest";

import {
  backdropEffectNeutralizations,
  backdropRootReasons,
  transformRotatesOrSkews,
  willChangePropertyForNeutralization,
  type BackdropEffectStyleFacts,
} from "./backdrop-effect-space.js";

const facts = (overrides: Partial<BackdropEffectStyleFacts> = {}): BackdropEffectStyleFacts => ({
  isDocumentRoot: false,
  opacity: "1",
  filter: "none",
  backdropFilter: "none",
  clipPath: "none",
  maskImage: "none",
  maskBorderSource: "none",
  mixBlendMode: "normal",
  willChange: "auto",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  ...overrides,
});

describe("DM-2487 Blink backdrop effect space", () => {
  it("classifies the exact root triggers and excludes non-root transitions", () => {
    expect(backdropRootReasons(facts({ isDocumentRoot: true }))).toEqual(["document-root"]);
    expect(backdropRootReasons(facts({ opacity: ".6" }))).toEqual(["opacity"]);
    expect(backdropRootReasons(facts({ filter: "blur(2px)" }))).toEqual(["filter"]);
    expect(backdropRootReasons(facts({ backdropFilter: "blur(2px)" }))).toEqual(["backdrop-filter"]);
    expect(backdropRootReasons(facts({ clipPath: "inset(1px)" }))).toEqual(["clip-path"]);
    expect(backdropRootReasons(facts({ maskImage: "linear-gradient(#000,#000)" }))).toEqual(["mask"]);
    expect(backdropRootReasons(facts({ mixBlendMode: "multiply" }))).toEqual(["mix-blend-mode"]);
    expect(backdropRootReasons(facts({ willChange: "opacity, mask" }))).toEqual(["will-change"]);
    expect(backdropRootReasons(facts({ transform: "matrix(1, 0, 0, 1, 4, 2)" }))).toEqual([]);
  });

  it("neutralizes only effects re-applied by SVG and retains an ancestor backdrop source", () => {
    expect(backdropEffectNeutralizations(facts({
      opacity: ".7",
      filter: "contrast(1.2)",
      backdropFilter: "blur(4px)",
      clipPath: "inset(2px)",
      maskImage: "linear-gradient(#000,#000)",
      mixBlendMode: "screen",
    }))).toEqual(["opacity", "filter", "clip-path", "mask"]);
  });

  it("matches the capture walk's rotation/skew freeze but leaves baked scale/translation live", () => {
    expect(transformRotatesOrSkews(facts({ transform: "matrix(1, .1, 0, 1, 0, 0)" }))).toBe(true);
    expect(transformRotatesOrSkews(facts({ rotate: "0.8deg" }))).toBe(true);
    expect(transformRotatesOrSkews(facts({ transform: "matrix(1.2, 0, 0, .8, 5, 3)" }))).toBe(false);
    expect(willChangePropertyForNeutralization("rotate-skew")).toBe("transform");
  });
});
