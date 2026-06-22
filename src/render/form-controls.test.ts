/**
 * Regression test for DM-866: a computed `font-family` that includes a quoted
 * family name (getComputedStyle normalizes multi-word families with double
 * quotes) must be emitted as valid XML — inner `"` would prematurely close the
 * attribute and break SVGO / strict XML parsers.
 */

import { describe, it, expect } from "vitest";
import { renderFormControl, parseSpreadOnlyShadows } from "./form-controls.js";

describe("parseSpreadOnlyShadows — slider-thumb donut rings (DM-1240)", () => {
  it("parses a single spread-only ring (the DM-319 pattern)", () => {
    expect(parseSpreadOnlyShadows("rgb(0, 200, 0) 0px 0px 0px 2px")).toEqual([{ spread: 2, color: "rgb(0, 200, 0)" }]);
  });

  it("parses a stacked multi-shadow list into multiple rings in source order", () => {
    expect(parseSpreadOnlyShadows("rgb(255, 255, 255) 0px 0px 0px 1px, rgb(0, 0, 255) 0px 0px 0px 3px")).toEqual([
      { spread: 1, color: "rgb(255, 255, 255)" },
      { spread: 3, color: "rgb(0, 0, 255)" },
    ]);
  });

  it("skips shadows with a non-zero offset or blur (not rings) but keeps the spread-only ones", () => {
    // A soft drop shadow (offset+blur) is not a ring; the spread-only one is.
    expect(parseSpreadOnlyShadows("rgba(0, 0, 0, 0.4) 0px 2px 4px 0px, rgb(0, 128, 0) 0px 0px 0px 2px")).toEqual([
      { spread: 2, color: "rgb(0, 128, 0)" },
    ]);
  });

  it("returns [] for none / inset / empty", () => {
    expect(parseSpreadOnlyShadows("none")).toEqual([]);
    expect(parseSpreadOnlyShadows(undefined)).toEqual([]);
    expect(parseSpreadOnlyShadows("inset 0px 0px 0px 2px red")).toEqual([]);
  });
});

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

describe("::details-content separator (DM-1152)", () => {
  function makeOpenDetails(box: Record<string, unknown> | undefined): Parameters<typeof renderFormControl>[0] {
    return {
      tag: "details",
      x: 44, y: 263, width: 740, height: 132,
      styles: {
        fontSize: "16", color: "rgb(0,0,0)", paddingLeft: "0", borderLeftWidth: "1",
        paddingTop: "0", borderTopWidth: "1", summaryMarkerSuppressed: true,
        detailsOpen: true,
        ...(box ? { detailsContentBox: box } : {}),
      },
      children: [{ tag: "summary", x: 44, y: 264, width: 740, height: 47, styles: {} }],
    } as unknown as Parameters<typeof renderFormControl>[0];
  }

  it("paints a 1px divider at the summary's bottom edge when ::details-content has a border-top", () => {
    const svg = renderFormControl(makeOpenDetails({
      borderTopWidth: 1, borderTopColor: "rgb(226, 232, 240)",
      paddingBottom: 0, borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1,
    }), "");
    // Divider at summary.y + summary.height = 264 + 47 = 311, full content width.
    expect(svg).toContain('y="311"');
    expect(svg).toContain('height="1"');
    expect(svg).toContain('fill="rgb(226, 232, 240)"');
  });

  it("paints the divider even when the summary marker is suppressed (list-style:none idiom)", () => {
    // The accordion pattern hides the UA triangle; the separator must still show.
    const svg = renderFormControl(makeOpenDetails({
      borderTopWidth: 1, borderTopColor: "rgb(226, 232, 240)",
      paddingBottom: 0, borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1,
    }), "");
    expect(svg).toContain('fill="rgb(226, 232, 240)"');
  });

  it("paints nothing extra when ::details-content carries no border (no detailsContentBox)", () => {
    const svg = renderFormControl(makeOpenDetails(undefined), "");
    expect(svg).not.toContain('fill="rgb(226, 232, 240)"');
  });
});

describe("native vs author-styled <meter> geometry (DM-1156 / DM-1155)", () => {
  function makeMeter(styles: Record<string, unknown>): Parameters<typeof renderFormControl>[0] {
    return {
      tag: "meter",
      x: 264, y: 100, width: 528, height: 16,
      styles: { meterValue: 9, meterMin: 0, meterMax: 10, meterLow: 3, meterHigh: 7, meterOptimum: 8, ...styles },
    } as unknown as Parameters<typeof renderFormControl>[0];
  }

  it("paints the native UA groove border (rgb(203,203,203)) around the bar", () => {
    // macOS Chrome paints native <meter> as a grooved bar with a crisp 1px
    // gray border. Author-styled meters (appearance:none) get no groove.
    const svg = renderFormControl(makeMeter({}), "");
    expect(svg).toContain('stroke="rgb(203,203,203)"');
    expect(svg).toContain('stroke-width="1"');
  });

  it("does NOT paint a groove on an author-styled (border-radius pill) meter", () => {
    const svg = renderFormControl(makeMeter({ meterBarRadius: "8px" }), "");
    expect(svg).not.toContain('stroke="rgb(203,203,203)"');
    // The pill track keeps its author radius.
    expect(svg).toContain('rx="8"');
  });

  it("insets the author-styled value fill to the center half-height (floor(h/4))", () => {
    // Chrome insets the value pseudo to the center ~half of the track: for a
    // 16px meter the value spans the center 8px (inset 4 top/bottom), not the
    // full height. Snapped box top = round(y) = 100, inset 4 → value y = 104.
    const svg = renderFormControl(makeMeter({ meterBarRadius: "8px" }), "");
    const rects = [...svg.matchAll(/<rect[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"[^>]*\/>/g)];
    // Two rects: the full-height track (y=100 h=16) and the inset value (y=104 h=8).
    const track = rects.find((m) => m[2] === "16");
    const value = rects.find((m) => m[2] === "8");
    expect(track).toBeDefined();
    expect(value).toBeDefined();
    expect(parseFloat(value![1])).toBe(104);
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
