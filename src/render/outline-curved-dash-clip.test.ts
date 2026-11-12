import { describe, expect, it } from "vitest";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import { paintOutline } from "./outline-paint.js";

// DM-C77Q41: Blink clips the doubled curved dash stroke with anti-aliased
// rounded-rect clips (outer clip, inner clip-out), so the renderer emits a
// rounded-rect clipPath plus an inner rounded-rect cut-out, not a path ring.
describe("rounded dashed/dotted outline clipping (DM-C77Q41)", () => {
  const outline = (style: string, radius: number) =>
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

  it("keeps the path ring when a radius exceeds half a side", () => {
    expect(outline("dashed", 30)).toContain('fill-rule="evenodd"');
  });
});
