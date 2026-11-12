import { describe, expect, it } from "vitest";
import { captureLegacyClipRect } from "./legacy-clip.js";

// DM-1C56DE: LayoutBox::ClipRect offsets the border box per non-auto side and
// paint uses the pixel-snapped rect; only out-of-flow boxes have a clip.
describe("captureLegacyClipRect (DM-1C56DE)", () => {
  const style = (overrides: Partial<CSSStyleDeclaration>) =>
    ({ position: "absolute", clip: "auto", transform: "none", rotate: "none", scale: "none", ...overrides }) as CSSStyleDeclaration;
  const run = (cs: CSSStyleDeclaration, zoom = 1) => {
    const warnings: string[] = [];
    const el = { parentElement: null, ownerDocument: { defaultView: {} } } as unknown as Element;
    const rect = captureLegacyClipRect({
      el,
      cs,
      rect: { left: 10.4, top: 20, width: 60, height: 50 },
      vp: { x: 0, y: 5 },
      zoom,
      sel: "#box",
      warn: (_selector, _property, message) => warnings.push(message),
    });
    return { rect, warnings };
  };

  it("offsets each non-auto side from the border box and snaps the edges", () => {
    expect(run(style({ clip: "rect(5px, 30px, 40px, 2px)" })).rect).toEqual({ x: 12, y: 20, width: 28, height: 35 });
    expect(run(style({ clip: "rect(auto, 30px, auto, 5px)" })).rect).toEqual({ x: 15, y: 15, width: 25, height: 50 });
    expect(run(style({ clip: "rect(-10px, 80px, 70px, -10px)" })).rect).toEqual({ x: 0, y: 5, width: 90, height: 80 });
    expect(run(style({ clip: "rect(0px, 0px, 0px, 0px)" })).rect).toEqual({ x: 10, y: 15, width: 0, height: 0 });
  });

  it("applies only to out-of-flow positioned boxes with a non-auto clip", () => {
    expect(run(style({ position: "fixed", clip: "rect(0px, 10px, 10px, 0px)" })).rect).toBeDefined();
    for (const position of ["static", "relative", "sticky"]) {
      expect(run(style({ position, clip: "rect(0px, 10px, 10px, 0px)" })).rect).toBeUndefined();
    }
    expect(run(style({})).rect).toBeUndefined();
  });

  it("warns instead of guessing under rotation, scale or zoom", () => {
    for (const overrides of [
      { transform: "matrix(0.98, 0.17, -0.17, 0.98, 0, 0)" },
      { rotate: "10deg" },
      { scale: "2" },
    ]) {
      const result = run(style({ clip: "rect(0px, 10px, 10px, 0px)", ...overrides }));
      expect(result.rect).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
    }
    expect(run(style({ clip: "rect(0px, 10px, 10px, 0px)", transform: "matrix(1, 0, 0, 1, 5, 7)" })).rect).toBeDefined();
    expect(run(style({ clip: "rect(0px, 10px, 10px, 0px)" }), 2).warnings).toHaveLength(1);
  });
});
