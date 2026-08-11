import { describe, expect, it } from "vitest";
import { generateAnimatedSvg, type AnimationFrame } from "./animator.js";

const content = (fill: string): string => `<rect width="1440" height="900" fill="${fill}" />`;
function render(transition: NonNullable<AnimationFrame["transition"]>, nextTransition: NonNullable<AnimationFrame["transition"]> = { type: "cut", duration: 0 }): string {
  return generateAnimatedSvg({
    width: 1440, height: 900,
    frames: [
      { svgContent: content("red"), duration: 500, transition },
      { svgContent: content("blue"), duration: 500, transition: nextTransition },
    ],
  });
}

describe("parameterized transition rendering", () => {
  it("pushes on an arbitrary viewport-relative vector and rests at identity", () => {
    const svg = render({ type: "push", duration: 300, push: { angle: 45, distance: 0.5 } });
    expect(svg).toContain("translate(509.11688245431424px, 318.19805153394634px)");
    expect(svg).toContain("transform: translate(0px, 0px)");
    expect(svg).not.toContain("filter:");
  });

  it("applies viewport-relative origins to radial reveals and zooms", () => {
    const radial = render({ type: "reveal", duration: 300, reveal: { shape: "radial", origin: { x: 0.25, y: 0.75 }, radius: 1 } });
    expect(radial).toMatch(/circle\(\d+px at 360px 675px\)/);
    const zoom = render({ type: "zoom", duration: 300, zoom: { fromScale: 1.4, origin: { x: 0.25, y: 0.75 } } });
    expect(zoom).toContain("transform: scale(1.4)");
    expect(zoom).toContain("transform-origin: 360px 675px");
  });

  it("passes bounded shine parameters into the shared safe sweep", () => {
    const svg = render({ type: "shine", duration: 300, shine: { angle: 30, bandWidth: 0.2, color: "#ffeeaa", opacity: 0.4 } });
    expect(svg).toContain('stop-color="#ffeeaa" stop-opacity="0.4"');
    expect(svg).toContain('width="288"');
    expect(svg).toContain("skewX(-30)");
  });

  it("composes parameterized entrances with a different exit family on one CSS timeline", () => {
    const svg = render(
      { type: "reveal", duration: 300, reveal: { shape: "clock", origin: { x: 0.4, y: 0.6 }, startAngle: 90, direction: "counterclockwise" } },
      { type: "zoom", duration: 250, zoom: { fromScale: 0.7, origin: { x: 0.5, y: 0.5 } } },
    );
    expect(svg).toContain("@keyframes fr-1");
    expect(svg).toContain("@keyframes fv-1");
    expect(svg).not.toContain("<animate");
    expect(svg).not.toContain("<script");
  });
});
