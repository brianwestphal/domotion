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

  it("composes a custom multi-primitive recipe without raw viewer code", () => {
    const svg = render({ type: "custom", duration: 400, easing: "ease-out", custom: {
      incoming: { opacity: 0.15, translate: { x: 0.2, y: -0.1 }, scale: { from: 0.8, origin: { x: 0.5, y: 0.5 } }, clip: { shape: "radial", origin: { x: 0.5, y: 0.5 }, radius: 1 } },
      outgoing: { opacity: 0.1, translate: { x: -0.15, y: 0.05 }, scale: { to: 1.2, origin: { x: 0.25, y: 0.75 } } },
      overlay: { angle: 20, bandWidth: 0.2, color: "#ccddff", opacity: 0.35 },
      reducedMotion: "cut", loop: "crossfade-to-first", zOrder: "incoming-on-top",
    } });
    for (const track of ["fv-0", "fp-0", "fz-1", "fzo-0", "fr-1", "shine-tr0"]) expect(svg).toContain(track);
    expect(svg).toContain("@media (prefers-reduced-motion: reduce)");
    expect(svg).not.toMatch(/<script|<animate|filter:|mask:/);
  });

  it("wraps frame zero into a custom crossfade-to-first loop", () => {
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        { svgContent: content("red"), duration: 500 },
        {
          svgContent: content("blue"),
          duration: 500,
          transition: {
            type: "custom",
            duration: 400,
            custom: {
              incoming: { opacity: 0 },
              outgoing: { opacity: 0 },
              reducedMotion: "crossfade",
              loop: "crossfade-to-first",
              zOrder: "incoming-on-top",
            },
          },
        },
      ],
    });
    const frameZero = svg.match(/@keyframes fv-0 \{(?:[^{}]|\{[^}]*\})*\}/)?.[0] ?? "";
    expect(frameZero).toMatch(/100%\s*\{\s*opacity:\s*1/);
  });
});
