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

describe("details disclosure marker: ::marker color / size / inside (DM-1123)", () => {
  // A `<details>` whose shown summary marker carries author `::marker` styling
  // (the `.with-marker` case in 08-deep-details-accordion). `summaryPad` sets
  // the summary's own padding-left (the inside-position offset driver).
  function makeDetails(extra: Record<string, unknown>, summaryStyles: Record<string, unknown> = {}): Parameters<typeof renderFormControl>[0] {
    return {
      tag: "details",
      x: 50, y: 0, width: 200, height: 44,
      styles: { fontSize: "16", color: "rgb(0,0,0)", paddingLeft: "0", borderLeftWidth: "0", paddingTop: "0", borderTopWidth: "0", ...extra },
      children: [{ tag: "summary", x: 50, y: 0, width: 200, height: 44, styles: summaryStyles }],
    } as unknown as Parameters<typeof renderFormControl>[0];
  }

  // Extract the smallest x coordinate from the rendered <polygon points="...">.
  function minPolygonX(svg: string): number {
    const m = /<polygon points="([^"]+)"/.exec(svg);
    if (m == null) throw new Error(`no polygon in: ${svg}`);
    return Math.min(...m[1].trim().split(/\s+/).map((pt) => parseFloat(pt.split(",")[0])));
  }

  it("paints the triangle in the computed ::marker color, not the summary text color", () => {
    const svg = renderFormControl(makeDetails({ summaryMarkerColor: "rgb(109,40,217)" }), "");
    expect(svg).toContain('fill="rgb(109,40,217)"');
    expect(svg).not.toContain('fill="rgb(0,0,0)"');
  });

  it("falls back to the summary text color when no ::marker color was captured (plain summary, pre-DM-1123 captures)", () => {
    const svg = renderFormControl(makeDetails({ color: "rgb(0,0,0)" }), "");
    expect(svg).toContain('fill="rgb(0,0,0)"');
  });

  it("scales the triangle with the ::marker font-size when the author set one", () => {
    // marker font-size 14 → size max(8, 9.8) = 9.8; summary's own 16 would give
    // 11.2. A smaller marker font-size yields a vertically shorter triangle.
    const small = renderFormControl(makeDetails({ summaryMarkerFontSize: 14 }), "");
    const big = renderFormControl(makeDetails({ summaryMarkerFontSize: 28 }), "");
    const yExtent = (svg: string): number => {
      const m = /<polygon points="([^"]+)"/.exec(svg)!;
      const ys = m[1].trim().split(/\s+/).map((pt) => parseFloat(pt.split(",")[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(yExtent(big)).toBeGreaterThan(yExtent(small));
  });

  it("offsets the inside-positioned marker past the summary's own padding-left", () => {
    // `.with-marker summary { padding-left: 24px }` + list-style-position:inside
    // → Chrome paints the triangle ~24px right of the border-box-left placement.
    const inside = renderFormControl(makeDetails({ summaryMarkerInside: true }, { paddingLeft: "24" }), "");
    const noOffset = renderFormControl(makeDetails({ summaryMarkerInside: false }, { paddingLeft: "24" }), "");
    expect(minPolygonX(inside) - minPolygonX(noOffset)).toBeCloseTo(24, 1);
  });

  it("does not shift plain (no-padding) summaries — no regression for the default marker", () => {
    const withFlag = renderFormControl(makeDetails({ summaryMarkerInside: true }, { paddingLeft: "0" }), "");
    const withoutFlag = renderFormControl(makeDetails({}, { paddingLeft: "0" }), "");
    expect(minPolygonX(withFlag)).toBeCloseTo(minPolygonX(withoutFlag), 5);
  });
});
