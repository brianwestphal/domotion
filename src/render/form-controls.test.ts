/**
 * Regression test for DM-866: a computed `font-family` that includes a quoted
 * family name (getComputedStyle normalizes multi-word families with double
 * quotes) must be emitted as valid XML — inner `"` would prematurely close the
 * attribute and break SVGO / strict XML parsers.
 */

import { describe, it, expect } from "vitest";
import { renderFormControl } from "./form-controls.js";

describe("form-controls font-family escaping (DM-866)", () => {
  it("escapes inner double-quotes in a <select>'s font-family attribute", () => {
    const el = {
      tag: "select",
      x: 0,
      y: 0,
      width: 120,
      height: 30,
      styles: {
        selectDisplayText: "Choose…",
        fontFamily: `-apple-system, "Segoe UI", system-ui, sans-serif`,
        fontSize: "13",
        fontWeight: "400",
        color: "rgb(0,0,0)",
        paddingLeft: "0",
        borderLeftWidth: "0",
      },
    } as unknown as Parameters<typeof renderFormControl>[0];

    const svg = renderFormControl(el, "");

    // The quoted family must round-trip with escaped quotes, never raw inner
    // double-quotes that would close the attribute early.
    expect(svg).toContain("&quot;Segoe UI&quot;");
    expect(svg).not.toContain(`"Segoe UI"`);

    // The font-family attribute value itself contains no bare double-quote.
    const m = /font-family="([^"]*)"/.exec(svg);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain(`"`);
  });
});

describe("details disclosure marker suppression (DM-1115 / DM-448)", () => {
  function makeDetails(extra: Record<string, unknown>): Parameters<typeof renderFormControl>[0] {
    return {
      tag: "details",
      x: 0,
      y: 0,
      width: 200,
      height: 44,
      styles: {
        fontSize: "16",
        color: "rgb(0,0,0)",
        paddingLeft: "0",
        borderLeftWidth: "0",
        paddingTop: "0",
        borderTopWidth: "0",
        ...extra,
      },
      children: [{ tag: "summary", x: 0, y: 0, width: 200, height: 44, styles: {} }],
    } as unknown as Parameters<typeof renderFormControl>[0];
  }

  it("paints a disclosure triangle when the marker is not suppressed", () => {
    const svg = renderFormControl(makeDetails({}), "");
    expect(svg).toContain("<polygon");
  });

  it("suppresses the triangle when the summary marker is hidden (DM-1115: list-style:none, DM-448: transparent ::marker)", () => {
    // The capture layer collapses both `list-style: none` and a transparent
    // `::marker` into `summaryMarkerSuppressed: true`; the renderer must paint
    // nothing so it doesn't stack a UA triangle over the author's custom marker.
    const svg = renderFormControl(makeDetails({ summaryMarkerSuppressed: true }), "");
    expect(svg).toBe("");
    expect(svg).not.toContain("<polygon");
  });
});
