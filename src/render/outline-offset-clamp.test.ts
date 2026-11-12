import { describe, expect, it } from "vitest";
import { capturedElement } from "../test-support/captured-fixtures.js";
import { adjustedOutlineOffset, paintOutline } from "./outline-paint.js";

// DM-GQJ8C4: Blink clamps a negative outline-offset per axis to half the
// pixel-snapped rect extent (outline_painter.cc:79-82, chromium 6b5a1b80).
function outlined(width: number, height: number, offset: string, style = "solid") {
  return capturedElement({
    tag: "div",
    x: 20,
    y: 20,
    width,
    height,
    styles: { outlineStyle: style, outlineWidth: "2px", outlineOffset: offset, outlineColor: "rgb(255, 0, 0)" },
  });
}

describe("adjustedOutlineOffset", () => {
  it("transcribes Blink's per-axis clamp with C++ integer division", () => {
    expect(adjustedOutlineOffset(20, 20, -20)).toEqual({ horizontal: -10, vertical: -10 });
    expect(adjustedOutlineOffset(21, 9, -20)).toEqual({ horizontal: -10, vertical: -4 });
    expect(adjustedOutlineOffset(40, 10, -3)).toEqual({ horizontal: -3, vertical: -3 });
    expect(adjustedOutlineOffset(0, 0, -5)).toEqual({ horizontal: 0, vertical: 0 });
    expect(adjustedOutlineOffset(20, 20, 4)).toEqual({ horizontal: 4, vertical: 4 });
  });
});

describe("paintOutline negative offset", () => {
  it("collapses a 20 px box with -20 px offset to Blink's 4 x 4 outline instead of inverting it", () => {
    const markup = paintOutline(outlined(20, 20, "-20px"), 0, "").join("\n");
    // Outer rect 28..32 on both axes; the 2 px stroke is centered on 29..31.
    expect(markup).toContain('x="29" y="29" width="2" height="2"');
    expect(markup).not.toMatch(/width="-|height="-/);
  });

  it("clamps each axis independently", () => {
    const markup = paintOutline(outlined(40, 10, "-20px"), 0, "").join("\n");
    // Horizontal clamp -20 (= -40/2), vertical -5: outer 38..42 x 23..27.
    expect(markup).toContain('x="39" y="24" width="2" height="2"');
  });

  it("leaves unclamped positive and small negative offsets unchanged", () => {
    expect(paintOutline(outlined(20, 20, "3px"), 0, "").join("\n")).toContain('x="16" y="16" width="28" height="28"');
    expect(paintOutline(outlined(20, 20, "-4px"), 0, "").join("\n")).toContain('x="23" y="23" width="14" height="14"');
  });

  it("keeps a rounded outline's rect from inverting", () => {
    const markup = paintOutline(outlined(20, 20, "-20px"), 6, "").join("\n");
    expect(markup).not.toMatch(/width="-|height="-/);
    expect(markup).toContain('x="29" y="29" width="2" height="2"');
  });
});
