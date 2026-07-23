import { describe, expect, it } from "vitest";
import { annotateAnimatedProperties } from "./annotate-animated-properties.js";
import type { CapturedElement } from "../capture/types.js";

function el(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div", text: "", x: 0, y: 0, width: 10, height: 10, children: [],
    styles: { opacity: "1" } as CapturedElement["styles"],
    ...overrides,
  };
}

describe("annotateAnimatedProperties", () => {
  it("sets animatedProperties on elements whose animId matches an animation", () => {
    const target = el({ animId: "f0a0" });
    const tree = [el({ children: [target] })];
    annotateAnimatedProperties(tree, [{ animId: "f0a0", property: "opacity" }]);
    expect(target.animatedProperties).toEqual(["opacity"]);
  });

  it("includes fused tracks' properties alongside the primary", () => {
    const target = el({ animId: "f0a0" });
    annotateAnimatedProperties([target], [
      { animId: "f0a0", property: "translateY", fuse: [{ property: "opacity" }] },
    ]);
    expect(target.animatedProperties).toEqual(expect.arrayContaining(["translateY", "opacity"]));
  });

  it("merges properties across multiple animations sharing one animId, without duplicates", () => {
    const target = el({ animId: "f0a0" });
    annotateAnimatedProperties([target], [
      { animId: "f0a0", property: "opacity" },
      { animId: "f0a0", property: "opacity" },
      { animId: "f0a0", property: "scale" },
    ]);
    expect(target.animatedProperties).toEqual(["opacity", "scale"]);
  });

  it("annotates every element sharing the animId (selector matched several)", () => {
    const a = el({ animId: "f0a0" });
    const b = el({ animId: "f0a0" });
    annotateAnimatedProperties([a, b], [{ animId: "f0a0", property: "opacity" }]);
    expect(a.animatedProperties).toEqual(["opacity"]);
    expect(b.animatedProperties).toEqual(["opacity"]);
  });

  it("leaves elements with a non-matching or absent animId untouched", () => {
    const other = el({ animId: "f0a1" });
    const plain = el();
    annotateAnimatedProperties([other, plain], [{ animId: "f0a0", property: "opacity" }]);
    expect(other.animatedProperties).toBeUndefined();
    expect(plain.animatedProperties).toBeUndefined();
  });

  it("is a no-op for an empty or undefined animation list", () => {
    const target = el({ animId: "f0a0" });
    annotateAnimatedProperties([target], []);
    annotateAnimatedProperties([target], undefined);
    expect(target.animatedProperties).toBeUndefined();
  });
});
