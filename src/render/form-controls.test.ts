/**
 * Regression test for DM-866: a computed `font-family` that includes a quoted
 * family name (getComputedStyle normalizes multi-word families with double
 * quotes) must be emitted as valid XML — inner `"` would prematurely close the
 * attribute and break SVGO / strict XML parsers.
 */

import { describe, it, expect } from "vitest";
import {
  checkablePseudoFactsOwnIndicator,
  renderFileSelectorOutsetShadow,
  renderFormControl,
  parseSpreadOnlyShadows,
  collectFormControlConicTiles,
} from "./form-controls.js";
import type { CapturedElement } from "../capture/types.js";

describe("source-owned checkable indicators (DM-2459)", () => {
  function checkable(
    type: "checkbox" | "radio",
    appearance: string,
    pseudoFragments: CapturedElement["pseudoFragments"] | undefined,
  ): CapturedElement {
    return {
      tag: "input", x: 10, y: 20, width: 24, height: 24, children: [],
      ...(pseudoFragments === undefined ? {} : { pseudoFragments }),
      styles: {
        inputType: type,
        inputAppearance: appearance,
        effectiveAppearance: appearance,
        checked: true,
        borderRadius: type === "radio" ? "50%" : "4px",
        borderTopColor: "rgb(12, 34, 56)",
      },
    } as unknown as CapturedElement;
  }

  it("suppresses generic synthesis for authoritative none/base pseudo facts, including an empty set", () => {
    for (const appearance of ["none", "base"]) {
      for (const type of ["checkbox", "radio"] as const) {
        const el = checkable(type, appearance, []);
        expect(checkablePseudoFactsOwnIndicator(el)).toBe(true);
        expect(renderFormControl(el, "")).toBe("");
      }
    }
  });

  it("retains generic synthesis only for old captures whose pseudo facts are undefined", () => {
    expect(renderFormControl(checkable("checkbox", "none", undefined), "")).toContain("<polyline");
    expect(renderFormControl(checkable("radio", "none", undefined), "")).toContain("<circle");
    expect(renderFormControl(checkable("checkbox", "base", undefined), "")).toContain("<polyline");
  });

  it("does not transfer native auto ownership merely because modern pseudo facts exist", () => {
    const checkbox = checkable("checkbox", "checkbox", []);
    checkbox.styles.inputAppearance = "auto";
    expect(checkablePseudoFactsOwnIndicator(checkbox)).toBe(false);
    expect(renderFormControl(checkbox, "")).toContain("<polyline");
  });
});

describe("author-styled listbox option rows (DM-2190)", () => {
  it("uses captured row geometry and :checked paint instead of native constants", () => {
    const el = {
      tag: "select", x: 250, y: 700, width: 540, height: 140, children: [],
      styles: {
        fontSize: "16px", fontFamily: "Arial", color: "rgb(0, 0, 0)",
        selectListboxOptions: [{
          text: "Red", selected: true, disabled: false,
          x: 5, y: 6.5, width: 530, height: 27.1875,
          backgroundColor: "rgb(238, 242, 255)", color: "rgb(49, 46, 129)",
          paddingLeft: 8, paddingTop: 4, fontSize: 16, fontFamily: "Arial",
          fontWeight: "400", fontStyle: "normal", fontAscent: 15,
        }],
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(el, "");
    expect(svg).toContain('<rect x="255" y="706.5" width="530" height="27.2" fill="rgb(238, 242, 255)"');
    expect(svg).toContain('<text x="263"');
    expect(svg).toContain('fill="rgb(49, 46, 129)"');
    expect(svg).not.toContain("rgb(180, 215, 255)");
  });
});

describe("Chromium-owned partial control decorations", () => {
  const reservation = {
    x: 0, y: 0, width: 100, height: 30,
    kinds: ["menulist-button-arrow" as const],
  };

  it("keeps select/date value text vector but suppresses sampled glyphs", () => {
    const select = {
      tag: "select", x: 10, y: 20, width: 150, height: 32, children: [],
      nativeControlDecorationRaster: reservation,
      styles: {
        selectDisplayText: "Structural value", selectChevron: true,
        fontFamily: "Arial", fontSize: "14px", color: "rgb(1,2,3)",
        paddingLeft: "6px", borderLeftWidth: "1px",
      },
    } as unknown as CapturedElement;
    const selectSvg = renderFormControl(select, "");
    expect(selectSvg).toContain("Structural value");
    expect(selectSvg).not.toContain("polyline");

    const date = {
      tag: "input", x: 10, y: 60, width: 180, height: 34, children: [],
      nativeControlDecorationRaster: {
        ...reservation,
        kinds: ["calendar-picker-indicator" as const],
      },
      styles: { inputType: "date", inputValue: "2026-08-22", fontSize: "13.333px", color: "black" },
    } as unknown as CapturedElement;
    const dateSvg = renderFormControl(date, "");
    expect(dateSvg).toContain("08/22/2026");
    expect(dateSvg).not.toContain("<g fill=\"none\"");
  });

  it("never reopens sampled search/spin paint for empty or failed reservations", () => {
    for (const inputType of ["search", "number"]) {
      const el = {
        tag: "input", x: 10, y: 20, width: 160, height: 32, children: [],
        nativeControlDecorationRaster: {
          ...reservation,
          kinds: [inputType === "search" ? "search-cancel-button" : "inner-spin-button"],
        },
        styles: {
          inputType, inputValue: "7", searchCancelButtonBg: "red",
          numberSpinButtonBg: "red",
        },
      } as unknown as CapturedElement;
      expect(renderFormControl(el, "")).toBe("");
    }
  });
});

describe("file-selector synthetic text (DM-2189)", () => {
  it("uses the shared glyph-path renderer when the resolved font is available", () => {
    const el = { tag: "input", x: 20, y: 20, width: 240, height: 36, children: [], styles: {
      inputType: "file", fileButtonFontFamily: "Arial", fileButtonFontSize: "13.3333px",
      fileButtonFontWeight: "400", fileButtonLabelWidth: 68, fileButtonPadding: "4px 8px",
      fileButtonMarginRight: "4px", inputMultiple: false,
    } } as unknown as CapturedElement;
    const svg = renderFormControl(el, "");
    expect(svg).toContain('role="img" aria-label="Choose File"');
    expect(svg).not.toContain("No file chosen</text>");
  });

  const exactFile = (native: boolean): CapturedElement => ({
    tag: "input", text: "", x: 20, y: 20, width: 280, height: 36, children: [],
    nativeControlDecorationRaster: native ? {
      x: 20, y: 20, width: 94, height: 30,
      kinds: ["file-selector-button"],
    } : undefined,
    styles: {
      inputType: "file", opacity: "1",
      borderTopWidth: "0px", borderRightWidth: "0px",
      borderBottomWidth: "0px", borderLeftWidth: "0px",
      fileSelectorButton: {
        x: 20, y: 20, width: 94, height: 30, text: "Browse…", textWidth: 52,
        fontSize: 14, fontFamily: "Arial", fontWeight: "400", fontStyle: "normal",
        fontAscent: 13, fontDescent: 3, color: "rgb(1, 2, 3)",
        boxShadow: "rgb(220, 30, 92) 7px 5px 0px 0px", borderRadius: "3px",
      },
      fileSelectorStatus: {
        x: 118, y: 25, width: 52, height: 18, text: "2 files",
        textSegments: [{ text: "2 files", x: 118, y: 25, width: 52, height: 18 }],
        fontSize: 14, fontFamily: "Arial", fontWeight: "400", fontStyle: "normal",
        fontAscent: 13, fontDescent: 3, color: "rgb(7, 8, 9)",
        writingMode: "horizontal-tb", textOrientation: "mixed", direction: "ltr",
      },
    },
  } as unknown as CapturedElement);

  it("reserves the exact native button while keeping Chromium's status vector", () => {
    const svg = renderFormControl(exactFile(true), "");
    expect(svg).toContain('aria-label="2 files"');
    expect(svg).not.toContain("Browse");
    expect(svg).not.toContain("Choose File");
  });

  it("keeps the author-owned route at the real child rect and actual labels", () => {
    const svg = renderFormControl(exactFile(false), "");
    expect(svg).toContain('<rect x="20" y="20" width="94" height="30"');
    expect(svg).toContain('aria-label="Browse…"');
    expect(svg).toContain('aria-label="2 files"');
    expect(svg).not.toContain("Choose File");
  });

  it("emits only the native split's shadow overflow outside the button crop", () => {
    const el = exactFile(true);
    let id = 0;
    const defsParts: string[] = [];
    const svg = renderFileSelectorOutsetShadow(el, "", {
      idPrefix: "t", defsParts, gradientCache: new Map(), nextGradId: () => `t${id++}`,
    }, true);
    expect(svg).toContain('fill="rgb(220, 30, 92)"');
    expect(defsParts.join("\n")).toContain("clip-rule=\"evenodd\"");
    expect(defsParts.join("\n")).toContain("M20,20h94v30h-94Z");
  });
});

describe("collectFormControlConicTiles — conic on range thumb/track (DM-1252)", () => {
  const rangeEl = (styles: Record<string, unknown>): CapturedElement =>
    ({ tag: "input", x: 20, y: 12, width: 200, height: 36, children: [], styles } as unknown as CapturedElement);

  it("surfaces a conic thumb at the thumb-diameter tile and a conic track at the track-thickness tile", () => {
    const tiles = collectFormControlConicTiles(rangeEl({
      inputType: "range",
      rangeThumbWidth: "36px", rangeThumbBgImage: "conic-gradient(red, blue)",
      rangeTrackBg: "rgb(204, 204, 204)", rangeTrackHeight: "8px", rangeTrackBgImage: "conic-gradient(green, yellow)",
    }));
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 36, h: 36 });   // circle thumb
    expect(tiles).toContainEqual({ layer: "conic-gradient(green, yellow)", w: 200, h: 8 }); // horizontal track
  });

  it("uses thumbW×thumbH for a non-circular (ellipse/rect) styled thumb", () => {
    const tiles = collectFormControlConicTiles(rangeEl({
      inputType: "range", rangeThumbWidth: "40px", rangeThumbHeight: "20px", rangeThumbRadius: "4px",
      rangeThumbBgImage: "conic-gradient(red, blue)",
    }));
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 40, h: 20 });
  });

  it("returns [] for a non-conic pseudo bg or a non-range control", () => {
    expect(collectFormControlConicTiles(rangeEl({ inputType: "range", rangeThumbWidth: "36px", rangeThumbBgImage: "linear-gradient(red, blue)" }))).toEqual([]);
    expect(collectFormControlConicTiles(rangeEl({ inputType: "text" }))).toEqual([]);
  });

  it("surfaces a conic color-swatch at the element box minus wrapper padding (DM-1254)", () => {
    const colorEl = (styles: Record<string, unknown>): CapturedElement =>
      ({ tag: "input", x: 20, y: 16, width: 80, height: 48, children: [], styles } as unknown as CapturedElement);
    // default 4px wrapper padding → 80-8 × 48-8
    expect(collectFormControlConicTiles(colorEl({ inputType: "color", colorSwatchBgImage: "conic-gradient(red, blue)" })))
      .toContainEqual({ layer: "conic-gradient(red, blue)", w: 72, h: 40 });
    // explicit wrapper padding
    expect(collectFormControlConicTiles(colorEl({ inputType: "color", colorSwatchBgImage: "conic-gradient(red, blue)", colorSwatchWrapperPadding: "2px" })))
      .toContainEqual({ layer: "conic-gradient(red, blue)", w: 76, h: 44 });
  });

  it("surfaces <progress> bar + value conic at the shared-geom rects (DM-1254)", () => {
    const el = { tag: "progress", x: 20, y: 12, width: 200, height: 24, children: [], styles: {
      progressValue: 0.7, progressMax: 1, progressBarRadius: "4px", // author-styled ⇒ barH = el.height
      progressBarBgImage: "conic-gradient(red, blue)", progressValueBgImage: "conic-gradient(green, yellow)",
    } } as unknown as CapturedElement;
    const tiles = collectFormControlConicTiles(el);
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 200, h: 24 });   // track: el.width × barH
    expect(tiles).toContainEqual({ layer: "conic-gradient(green, yellow)", w: 140, h: 24 }); // value: el.width·0.7 × barH
  });

  it("surfaces <meter> bar + region-selected value conic at the shared-geom rects (DM-1254)", () => {
    const el = { tag: "meter", x: 20, y: 12, width: 200, height: 24, children: [], styles: {
      meterValue: 0.6, meterMin: 0, meterMax: 1, meterOptimum: 1, meterBarRadius: "3px", // author-styled
      meterBarBgImage: "conic-gradient(red, blue)", meterOptimumBgImage: "conic-gradient(green, yellow)",
    } } as unknown as CapturedElement;
    const tiles = collectFormControlConicTiles(el);
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 200, h: 24 });   // track
    // value=0.6 in [low,high] same region as optimum ⇒ "optimum" pseudo; styled value rect:
    // top=12 fullH=24 vInset=6 valueH=12, valueW=200·0.6=120.
    expect(tiles).toContainEqual({ layer: "conic-gradient(green, yellow)", w: 120, h: 12 });
  });
});

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

describe("details disclosure paint ownership (DM-2457)", () => {
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

  it("never synthesizes a marker from legacy details-parent fields", () => {
    // The marker is a generated child of `<summary>`, not paint owned by the
    // `<details>` form-control route. Both shown and suppressed old-capture
    // fields therefore fail closed here; the generic list-marker route owns
    // only a source-recorded marker fragment.
    const svg = renderFormControl(makeDetails({
      summaryMarkerSuppressed: false,
      summaryMarkerColor: "rgb(109,40,217)",
      summaryMarkerFontSize: 28,
      summaryMarkerInside: true,
    }), "");
    expect(svg).toBe("");
    expect(svg).not.toContain("<polygon");
  });
});
