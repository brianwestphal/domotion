import { describe, expect, it } from "vitest";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import { paintOutline } from "./outline-paint.js";

// DM-C77Q41: Blink clips the doubled curved dash stroke with anti-aliased
// rounded-rect clips (outer clip, inner clip-out), so the renderer emits a
// rounded-rect clipPath plus an inner rounded-rect cut-out, not a path ring.
describe("rounded dashed/dotted outline clipping (DM-C77Q41)", () => {
  const outline = (style: string, radius: number, corners: Record<string, string> = {}) =>
    paintOutline(
      capturedElement({
        tag: "div",
        x: 20,
        y: 20,
        width: 20,
        height: 20,
        styles: capturedStyles({
          outlineStyle: style,
          outlineWidth: "2px",
          outlineColor: "rgb(255, 0, 0)",
          outlineOffset: "0px",
          borderTopLeftRadius: `${radius}px`,
          borderTopRightRadius: `${radius}px`,
          borderBottomRightRadius: `${radius}px`,
          borderBottomLeftRadius: `${radius}px`,
          ...corners,
        }),
      }),
      radius,
      "",
    ).join("\n");

  it("clips to the outer rounded rect and cuts out the inner one", () => {
    for (const style of ["dashed", "dotted"]) {
      const markup = outline(style, 5);
      expect(markup).toMatch(
        /<clipPath id="([^"]+)-outer"><rect x="18" y="18" width="24" height="24" rx="7" ry="7"\/><\/clipPath>/,
      );
      expect(markup).toContain('<rect x="20" y="20" width="20" height="20" rx="5" ry="5" fill="black"/>');
      expect(markup).not.toContain('fill-rule="evenodd"');
      expect(markup).toMatch(/<g clip-path="url\(#[^"]+-outer\)"><path [^>]*mask="url\(#[^"]+\)" \/><\/g>/);
    }
  });

  // DM-1110JP: per-corner radii intersect one rounded-rect clip per corner.
  it("intersects per-corner rounded-rect clips instead of a path ring", () => {
    const markup = outline("dashed", 5, { borderTopRightRadius: "2px" });
    expect(markup).toContain('<rect x="13" y="18" width="29" height="29" rx="4" ry="4"/>');
    expect(markup).toMatch(/<g clip-path="url\(#[^"]+-outer\)"><g clip-path="url\(#[^"]+-outer-1\)">/);
    expect(markup).not.toContain('fill-rule="evenodd"');
  });

  // DM-2PSXZV: per-corner and elliptical radii shape the dash path and clip,
  // instead of one scalar radius taken from the top-left corner.
  it("uses each corner's own radius, including a square top-left", () => {
    const markup = outline("dashed", 5, { borderTopLeftRadius: "0px" });
    expect(markup).toContain("<path d=");
    expect(markup).not.toContain("<line ");
    expect(markup).toMatch(/A6,6 0 0 1/);
  });

  it("carries elliptical radii into the clip rect", () => {
    const markup = outline("dotted", 0, {
      borderTopLeftRadius: "6px 3px",
      borderTopRightRadius: "6px 3px",
      borderBottomRightRadius: "6px 3px",
      borderBottomLeftRadius: "6px 3px",
    });
    expect(markup).toContain('rx="8" ry="5"/></clipPath>');
  });
});

describe("rounded double outlines (DM-2PSXZV)", () => {
  const double = (corners: Record<string, string>) =>
    paintOutline(
      capturedElement({
        tag: "div",
        x: 20,
        y: 20,
        width: 20,
        height: 20,
        styles: capturedStyles({
          outlineStyle: "double",
          outlineWidth: "6px",
          outlineColor: "rgb(255, 0, 0)",
          outlineOffset: "0px",
          ...corners,
        }),
      }),
      0,
      "",
    ).join("\n");

  it("fills Blink's two stripe rings between per-corner contours", () => {
    const markup = double({ borderTopRightRadius: "4px" });
    const rings = markup.split("\n");
    expect(rings).toHaveLength(2);
    // Outer stripe: outer contour (outset 6) to round(6/3)=2 inside it; inner
    // stripe: round(12/3)=4 inside it to the inner contour (outset 0).
    expect(rings[0]).toContain("M14,14");
    expect(rings[0]).toContain("A10,10 0 0 1");
    expect(rings[0]).toContain("A8,8 0 0 1");
    expect(rings[1]).toContain("A6,6 0 0 1");
    expect(rings[1]).toContain("A4,4 0 0 1");
    expect(rings.every((ring) => ring.includes('fill-rule="evenodd"'))).toBe(true);
  });
});
