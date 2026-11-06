/**
 * Regression test for DM-866: a computed `font-family` that includes a quoted
 * family name (getComputedStyle normalizes multi-word families with double
 * quotes) must be emitted as valid XML — inner `"` would prematurely close the
 * attribute and break SVGO / strict XML parsers.
 */

import { describe, it, expect, vi } from "vitest";
import { getLastCaptureWarnings, resetLastCaptureWarnings } from "../capture/warnings.js";
import { renderFileSelectorOutsetShadow, renderFormControl, collectFormControlConicTiles } from "./form-controls.js";
import { checkablePseudoFactsOwnIndicator } from "../test-support/checkable-pseudo-contract.js";
import type { CapturedElement } from "../capture/types.js";

describe("source-owned checkable indicators (DM-2459)", () => {
  function checkable(
    type: "checkbox" | "radio",
    appearance: string,
    pseudoFragments: CapturedElement["pseudoFragments"] | undefined,
  ): CapturedElement {
    return {
      tag: "input",
      x: 10,
      y: 20,
      width: 24,
      height: 24,
      children: [],
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

  it("does not revive sampled indicators for old structural captures", () => {
    expect(renderFormControl(checkable("checkbox", "none", undefined), "")).toBe("");
    expect(renderFormControl(checkable("radio", "none", undefined), "")).toBe("");
    expect(renderFormControl(checkable("checkbox", "base", undefined), "")).toBe("");
  });

  it("fails closed when native auto ownership lacks its captured surface", () => {
    const checkbox = checkable("checkbox", "checkbox", []);
    checkbox.styles.inputAppearance = "auto";
    expect(checkablePseudoFactsOwnIndicator(checkbox)).toBe(false);
    expect(renderFormControl(checkbox, "")).toBe("");
  });
});

describe("author-styled listbox option rows (DM-2190)", () => {
  it("uses captured row geometry and :checked paint instead of native constants", () => {
    const el = {
      tag: "select",
      x: 250,
      y: 700,
      width: 540,
      height: 140,
      children: [],
      styles: {
        effectiveAppearance: "listbox",
        fontSize: "16px",
        fontFamily: "Arial",
        color: "rgb(0, 0, 0)",
        selectListboxOptions: [
          {
            text: 'Red "sale"',
            selected: true,
            disabled: false,
            x: 5,
            y: 6.5,
            width: 530,
            height: 27.1875,
            backgroundColor: "rgb(238, 242, 255)",
            color: "rgb(49, 46, 129)",
            paddingLeft: 8,
            paddingTop: 4,
            fontSize: 16,
            fontFamily: "Arial",
            fontWeight: "400",
            fontStyle: "normal",
            fontAscent: 15,
          },
        ],
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(el, "");
    expect(svg).toContain('<rect x="255" y="706.5" width="530" height="27.2" fill="rgb(238, 242, 255)"');
    expect(svg).toContain('<text x="263"');
    expect(svg).toContain('fill="rgb(49, 46, 129)"');
    expect(svg).toContain("Red &quot;sale&quot;");
    expect(svg).not.toContain("rgb(180, 215, 255)");
  });
});

describe("Chromium-owned partial control decorations", () => {
  const reservation = {
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    kinds: ["menulist-button-arrow" as const],
  };

  it("keeps captured structural select text but suppresses sampled picker glyphs", () => {
    const select = {
      tag: "select",
      x: 10,
      y: 20,
      width: 150,
      height: 32,
      children: [],
      fontAscent: 12,
      fontDescent: 3,
      nativeControlDecorationRaster: reservation,
      styles: {
        effectiveAppearance: "menulist-button",
        selectDisplayText: "Structural value",
        selectChevron: true,
        fontFamily: "Arial",
        fontSize: "14px",
        color: "rgb(1,2,3)",
        paddingLeft: "6px",
        paddingTop: "2px",
        paddingBottom: "2px",
        borderLeftWidth: "1px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
      },
    } as unknown as CapturedElement;
    const selectSvg = renderFormControl(select, "");
    expect(selectSvg).toContain("Structural value");
    expect(selectSvg).not.toContain("polyline");
    expect(selectSvg).not.toContain('<path d="M');

    const date = {
      tag: "input",
      x: 10,
      y: 60,
      width: 180,
      height: 34,
      children: [],
      nativeControlDecorationRaster: {
        ...reservation,
        kinds: ["calendar-picker-indicator" as const],
      },
      styles: {
        inputType: "date",
        effectiveAppearance: "none",
        inputValue: "2026-08-22",
        fontSize: "13.333px",
        color: "black",
      },
    } as unknown as CapturedElement;
    const dateSvg = renderFormControl(date, "");
    expect(dateSvg).toBe("");
  });

  it("paints the base-select picker icon at the inline end from captured styles", () => {
    const select = {
      tag: "select",
      x: 10,
      y: 20,
      width: 150,
      height: 32,
      children: [],
      fontAscent: 12,
      fontDescent: 3,
      styles: {
        effectiveAppearance: "base-select",
        selectDisplayText: "Structural value",
        selectChevron: true,
        selectChevronColor: "rgb(71, 85, 105)",
        fontFamily: "Arial",
        fontSize: "14px",
        color: "rgb(1,2,3)",
        paddingLeft: "6px",
        paddingRight: "10px",
        paddingTop: "2px",
        paddingBottom: "2px",
        borderLeftWidth: "1px",
        borderRightWidth: "1px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(select, "");
    const polygon = /<polygon points="([^"]+)" fill="rgb\(71, 85, 105\)" \/>/.exec(svg);
    expect(polygon).not.toBeNull();
    const pts = polygon![1].split(/\s+/).map((p) => p.split(",").map(Number));
    // 14 px font: a 9.24 px square (0.66 em). Its right edge is the content-box edge (10 + 150 - 1 - 10 = 149) and
    // its top is line top (23 + (26 - 15) / 2 = 28.5) + trunc(ascent 12) - 9.24 = 31.26.
    const left = 149 - 9.24;
    expect(pts[0][0]).toBeCloseTo(left, 2);
    expect(pts[2][0]).toBeCloseTo(149, 2);
    expect(pts[1][0]).toBeCloseTo(left + 9.24 / 2, 2);
    expect(pts[0][1]).toBeCloseTo(31.26 + 0.07 * 9.24, 2);
    expect(pts[1][1]).toBeCloseTo(31.26 + 0.93 * 9.24, 2);
  });

  it("uses Blink's closed-UA-shadow select text geometry when available", () => {
    const select = {
      tag: "select",
      x: 10,
      y: 20,
      width: 150,
      height: 44,
      children: [],
      fontAscent: 12,
      fontDescent: 3,
      styles: {
        effectiveAppearance: "base-select",
        selectDisplayText: "Structural value",
        // A 24px used line-height puts the glyph cell at y=30, whereas
        // centering font bounds in the content box would produce y=34.5.
        selectDisplayTextGeometry: { x: 22, y: 30, fontAscent: 12 },
        fontFamily: "Arial",
        fontSize: "14px",
        color: "rgb(1,2,3)",
        paddingLeft: "6px",
        paddingTop: "2px",
        paddingBottom: "2px",
        borderLeftWidth: "1px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(select, "");
    expect(svg).toContain('<text x="22" y="42"');
  });

  it("never reopens sampled search/spin paint for empty or failed reservations", () => {
    for (const inputType of ["search", "number"]) {
      const el = {
        tag: "input",
        x: 10,
        y: 20,
        width: 160,
        height: 32,
        children: [],
        nativeControlDecorationRaster: {
          ...reservation,
          kinds: [inputType === "search" ? "search-cancel-button" : "inner-spin-button"],
        },
        styles: {
          inputType,
          effectiveAppearance: "none",
          inputValue: "7",
          searchCancelButtonBg: "red",
          numberSpinButtonBg: "red",
        },
      } as unknown as CapturedElement;
      expect(renderFormControl(el, "")).toBe("");
    }
  });
});

describe("file-selector source-owned paint (DM-2189 / DM-2458)", () => {
  it("does not invent a localized button or status for incomplete captures", () => {
    const el = {
      tag: "input",
      x: 20,
      y: 20,
      width: 240,
      height: 36,
      children: [],
      styles: {
        inputType: "file",
        effectiveAppearance: "none",
        fileButtonFontFamily: "Arial",
        fileButtonFontSize: "13.3333px",
        fileButtonFontWeight: "400",
        fileButtonLabelWidth: 68,
        fileButtonPadding: "4px 8px",
        fileButtonMarginRight: "4px",
        inputMultiple: false,
      },
    } as unknown as CapturedElement;
    const svg = renderFormControl(el, "");
    expect(svg).toBe("");
    expect(svg).not.toContain("Choose File");
  });

  const exactFile = (native: boolean): CapturedElement =>
    ({
      tag: "input",
      text: "",
      x: 20,
      y: 20,
      width: 280,
      height: 36,
      children: [],
      nativeControlDecorationRaster: native
        ? {
            x: 20,
            y: 20,
            width: 94,
            height: 30,
            kinds: ["file-selector-button"],
          }
        : undefined,
      styles: {
        inputType: "file",
        effectiveAppearance: "none",
        opacity: "1",
        borderTopWidth: "0px",
        borderRightWidth: "0px",
        borderBottomWidth: "0px",
        borderLeftWidth: "0px",
        fileButtonBg: "rgb(240, 241, 242)",
        fileButtonBorder: "1px solid rgb(90, 91, 92)",
        fileSelectorButton: {
          x: 20,
          y: 20,
          width: 94,
          height: 30,
          text: "Browse…",
          textWidth: 52,
          fontSize: 14,
          fontFamily: "Arial",
          fontWeight: "400",
          fontStyle: "normal",
          fontAscent: 13,
          fontDescent: 3,
          color: "rgb(1, 2, 3)",
          boxShadow: "rgb(220, 30, 92) 7px 5px 0px 0px",
          borderRadius: "3px",
        },
        fileSelectorStatus: {
          x: 118,
          y: 25,
          width: 52,
          height: 18,
          text: "2 files",
          textSegments: [{ text: "2 files", x: 118, y: 25, width: 52, height: 18 }],
          fontSize: 14,
          fontFamily: "Arial",
          fontWeight: "400",
          fontStyle: "normal",
          fontAscent: 13,
          fontDescent: 3,
          color: "rgb(7, 8, 9)",
          writingMode: "horizontal-tb",
          textOrientation: "mixed",
          direction: "ltr",
        },
      },
    }) as unknown as CapturedElement;

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
    const svg = renderFileSelectorOutsetShadow(
      el,
      "",
      {
        idPrefix: "t",
        defsParts,
        gradientCache: new Map(),
        nextGradId: () => `t${id++}`,
      },
      true,
    );
    expect(svg).toContain('fill="rgb(220, 30, 92)"');
    expect(defsParts.join("\n")).toContain('clip-rule="evenodd"');
    expect(defsParts.join("\n")).toContain("M20,20h94v30h-94Z");
  });
});

describe("multi-layer form-control pseudo backgrounds", () => {
  const ctx = () => {
    const defsParts: string[] = [];
    let n = 0;
    return {
      defsParts,
      ctx: { idPrefix: "t", defsParts, gradientCache: new Map<string, string>(), nextGradId: () => `tgrad${n++}` },
    };
  };
  const progress = (styles: Record<string, unknown>): CapturedElement =>
    ({
      tag: "progress",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      children: [],
      styles: { effectiveAppearance: "none", progressValue: 0.5, progressMax: 1, progressBarRadius: "0px", ...styles },
    }) as unknown as CapturedElement;

  it("paints every gradient layer bottom-to-top over the background color", () => {
    const { defsParts, ctx: defCtx } = ctx();
    const svg = renderFormControl(
      progress({
        progressBarBg: "rgb(10, 20, 30)",
        progressBarBgImage:
          "repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.3) 0px, rgba(255, 255, 255, 0.3) 4px, transparent 4px, transparent 8px), linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))",
      }),
      "",
      defCtx,
    );
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    // The LAST-listed (bottom) layer, then the first-listed (top). The opaque
    // bottom gradient occludes the color, which Blink therefore does not paint
    // (box_painter_base.cc:697-700, Chromium 7d859f27).
    expect(fills.slice(0, 2)).toEqual(["url(#tgrad0)", "url(#tgrad1)"]);
    expect(fills).not.toContain("rgb(10, 20, 30)");
    const defs = defsParts.join("\n");
    expect(defs).toMatch(/id="tgrad0"[^\n]*rgb\(255,0,0\)/);
    expect(defs).toMatch(/id="tgrad1"[^\n]*rgba\(255,255,255,0\.3\)/);
  });

  it("paints the color under a translucent bottom layer of a list", () => {
    const { ctx: defCtx } = ctx();
    const svg = renderFormControl(
      progress({
        progressBarBg: "rgb(10, 20, 30)",
        progressBarBgImage:
          "linear-gradient(rgba(255, 255, 255, 0.3), transparent), linear-gradient(rgb(255, 0, 0), rgba(0, 0, 255, 0.5))",
      }),
      "",
      defCtx,
    );
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.slice(0, 3)).toEqual(["rgb(10, 20, 30)", "url(#tgrad0)", "url(#tgrad1)"]);
  });

  // Blink paints the color under a single translucent gradient layer too
  // (BoxPainterBase::PaintFillLayers, box_painter_base.cc:59-85, Chromium
  // 7d859f27), at every pseudo site.
  it("paints the color under a single translucent gradient layer", () => {
    const { ctx: defCtx } = ctx();
    const svg = renderFormControl(
      progress({
        progressBarBg: "rgb(10, 20, 30)",
        progressBarBgImage: "linear-gradient(transparent, rgba(255, 0, 0, 0.5))",
        progressValueBg: "rgb(0, 128, 0)",
        progressValueBgImage: "linear-gradient(rgba(255, 255, 255, 0.4), transparent)",
      }),
      "",
      defCtx,
    );
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills).toEqual(["rgb(10, 20, 30)", "url(#tgrad0)", "rgb(0, 128, 0)", "url(#tgrad1)"]);
  });

  it("paints the color under single translucent meter bar and value layers", () => {
    const { ctx: defCtx } = ctx();
    const meter = {
      tag: "meter",
      x: 0,
      y: 0,
      width: 100,
      height: 16,
      children: [],
      styles: {
        effectiveAppearance: "none",
        meterValue: 0.7,
        meterBarBg: "rgb(15, 118, 110)",
        meterBarBgImage: "linear-gradient(90deg, transparent, rgba(0, 0, 0, 0.5))",
        meterOptimumBg: "rgb(124, 58, 237)",
        meterOptimumBgImage: "linear-gradient(rgba(255, 255, 255, 0.55), transparent)",
      },
    } as unknown as CapturedElement;
    const fills = [...renderFormControl(meter, "", defCtx).matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills).toEqual(["rgb(15, 118, 110)", "url(#tgrad0)", "rgb(124, 58, 237)", "url(#tgrad1)"]);
  });

  it("paints the color-swatch color under a single translucent swatch layer", () => {
    const { ctx: defCtx } = ctx();
    const swatch = {
      tag: "input",
      x: 0,
      y: 0,
      width: 80,
      height: 36,
      children: [],
      styles: {
        effectiveAppearance: "none",
        inputType: "color",
        inputValue: "#e11d48",
        colorSwatchWrapperPadding: "4px",
        colorSwatchBg: "rgb(225, 29, 72)",
        colorSwatchBgImage: "linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.8))",
      },
    } as unknown as CapturedElement;
    const fills = [...renderFormControl(swatch, "", defCtx).matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.slice(-2)).toEqual(["rgb(225, 29, 72)", "url(#tgrad0)"]);
  });

  it("does not paint the color under a single opaque gradient layer, which occludes it", () => {
    const { ctx: defCtx } = ctx();
    const svg = renderFormControl(
      progress({
        progressBarBg: "rgb(10, 20, 30)",
        progressBarBgImage: "linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))",
      }),
      "",
      defCtx,
    );
    expect([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1])[0]).toBe("url(#tgrad0)");
    expect(svg).not.toContain('fill="rgb(10, 20, 30)"');
  });

  it("omits a non-gradient layer with a named warning instead of dropping every layer", () => {
    resetLastCaptureWarnings([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx: defCtx } = ctx();
    const svg = renderFormControl(
      progress({ progressBarBgImage: 'url("data:image/png;base64,AAAA"), linear-gradient(red, blue)' }),
      "",
      defCtx,
    );
    warn.mockRestore();
    expect(svg).toContain('fill="url(#tgrad0)"');
    expect(getLastCaptureWarnings()).toEqual([
      expect.objectContaining({
        feature: "form-control-background-layer",
        detail: expect.stringContaining("layer 1 of 2"),
      }),
    ]);
  });

  it("collects each conic layer of a list as its own tile", () => {
    const tiles = collectFormControlConicTiles(
      progress({
        progressBarRadius: "4px",
        progressBarBgImage: "conic-gradient(red, blue), linear-gradient(red, blue), conic-gradient(green, yellow)",
      }),
    );
    expect(tiles.filter((tile) => tile.w === 100)).toEqual([
      { layer: "conic-gradient(red, blue)", w: 100, h: 20 },
      { layer: "conic-gradient(green, yellow)", w: 100, h: 20 },
    ]);
  });
});

describe("collectFormControlConicTiles — conic on range thumb/track (DM-1252)", () => {
  const rangeEl = (styles: Record<string, unknown>): CapturedElement =>
    ({ tag: "input", x: 20, y: 12, width: 200, height: 36, children: [], styles }) as unknown as CapturedElement;

  it("surfaces a conic thumb at the thumb-diameter tile and a conic track at the track-thickness tile", () => {
    const tiles = collectFormControlConicTiles(
      rangeEl({
        inputType: "range",
        rangeThumbWidth: "36px",
        rangeThumbHeight: "36px",
        rangeThumbRadius: "18px",
        rangeThumbBgImage: "conic-gradient(red, blue)",
        rangeTrackBg: "rgb(204, 204, 204)",
        rangeTrackHeight: "8px",
        rangeTrackBgImage: "conic-gradient(green, yellow)",
      }),
    );
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 36, h: 36 }); // circle thumb
    expect(tiles).toContainEqual({ layer: "conic-gradient(green, yellow)", w: 200, h: 8 }); // horizontal track
  });

  it("uses thumbW×thumbH for a non-circular (ellipse/rect) styled thumb", () => {
    const tiles = collectFormControlConicTiles(
      rangeEl({
        inputType: "range",
        rangeTrackBg: "transparent",
        rangeTrackHeight: "8px",
        rangeThumbWidth: "40px",
        rangeThumbHeight: "20px",
        rangeThumbRadius: "4px",
        rangeThumbBgImage: "conic-gradient(red, blue)",
      }),
    );
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 40, h: 20 });
  });

  it("returns [] for a non-conic pseudo bg or a non-range control", () => {
    expect(
      collectFormControlConicTiles(
        rangeEl({ inputType: "range", rangeThumbWidth: "36px", rangeThumbBgImage: "linear-gradient(red, blue)" }),
      ),
    ).toEqual([]);
    expect(collectFormControlConicTiles(rangeEl({ inputType: "text" }))).toEqual([]);
  });

  it("surfaces a conic color-swatch at the element box minus wrapper padding (DM-1254)", () => {
    const colorEl = (styles: Record<string, unknown>): CapturedElement =>
      ({ tag: "input", x: 20, y: 16, width: 80, height: 48, children: [], styles }) as unknown as CapturedElement;
    // Missing wrapper geometry fails closed instead of substituting 4px.
    expect(
      collectFormControlConicTiles(colorEl({ inputType: "color", colorSwatchBgImage: "conic-gradient(red, blue)" })),
    ).toEqual([]);
    // explicit wrapper padding
    expect(
      collectFormControlConicTiles(
        colorEl({
          inputType: "color",
          colorSwatchBgImage: "conic-gradient(red, blue)",
          colorSwatchWrapperPadding: "2px",
        }),
      ),
    ).toContainEqual({ layer: "conic-gradient(red, blue)", w: 76, h: 44 });
  });

  it("surfaces <progress> bar + value conic at the shared-geom rects (DM-1254)", () => {
    const el = {
      tag: "progress",
      x: 20,
      y: 12,
      width: 200,
      height: 24,
      children: [],
      styles: {
        progressValue: 0.7,
        progressMax: 1,
        progressBarRadius: "4px", // author-styled ⇒ barH = el.height
        progressBarBgImage: "conic-gradient(red, blue)",
        progressValueBgImage: "conic-gradient(green, yellow)",
      },
    } as unknown as CapturedElement;
    const tiles = collectFormControlConicTiles(el);
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 200, h: 24 }); // track: el.width × barH
    expect(tiles).toContainEqual({ layer: "conic-gradient(green, yellow)", w: 140, h: 24 }); // value: el.width·0.7 × barH
  });

  it("omits fully transparent pseudo colors regardless of RGB channels", () => {
    const el = {
      tag: "progress",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      children: [],
      styles: {
        progressValue: 0.5,
        progressMax: 1,
        progressBarBg: "rgba(200, 10, 20, 0)",
        progressValueBg: "transparent",
      },
    } as unknown as CapturedElement;
    expect(renderFormControl(el, "")).not.toContain("<rect");
  });

  it("surfaces <meter> bar + region-selected value conic at the shared-geom rects (DM-1254)", () => {
    const el = {
      tag: "meter",
      x: 20,
      y: 12,
      width: 200,
      height: 24,
      children: [],
      styles: {
        meterValue: 0.6,
        meterMin: 0,
        meterMax: 1,
        meterOptimum: 1,
        meterBarRadius: "3px", // author-styled
        meterBarBgImage: "conic-gradient(red, blue)",
        meterOptimumBgImage: "conic-gradient(green, yellow)",
      },
    } as unknown as CapturedElement;
    const tiles = collectFormControlConicTiles(el);
    expect(tiles).toContainEqual({ layer: "conic-gradient(red, blue)", w: 200, h: 24 }); // track
    // value=0.6 in [low,high] same region as optimum ⇒ "optimum" pseudo; styled value rect:
    // top=12 fullH=24 vInset=6 valueH=12, valueW=200·0.6=120.
    expect(tiles).toContainEqual({ layer: "conic-gradient(green, yellow)", w: 120, h: 12 });
  });
});

describe("range pseudo box-shadow through the general painter", () => {
  const defCtx = () => {
    const defsParts: string[] = [];
    let n = 0;
    return {
      defsParts,
      ctx: { idPrefix: "t", defsParts, gradientCache: new Map<string, string>(), nextGradId: () => `tgrad${n++}` },
    };
  };
  const range = (styles: Record<string, unknown>): CapturedElement =>
    ({
      tag: "input",
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      children: [],
      styles: {
        effectiveAppearance: "none",
        inputType: "range",
        inputValue: "50",
        inputMin: "0",
        inputMax: "100",
        rangeTrackBg: "rgb(200, 200, 200)",
        rangeTrackHeight: "8px",
        rangeTrackRadius: "4px",
        rangeThumbBg: "rgb(30, 64, 175)",
        rangeThumbWidth: "20px",
        rangeThumbHeight: "20px",
        rangeThumbRadius: "10px",
        ...styles,
      },
    }) as unknown as CapturedElement;
  const order = (svg: string, ...needles: string[]): number[] => needles.map((needle) => svg.indexOf(needle));

  it("keeps stacked spread-only thumb rings concentric, largest below", () => {
    const { ctx } = defCtx();
    const svg = renderFormControl(
      range({ rangeThumbBoxShadow: "rgb(255, 255, 255) 0px 0px 0px 1px, rgb(0, 0, 255) 0px 0px 0px 3px" }),
      "",
      ctx,
    );
    const [blue, white, thumb] = order(
      svg,
      'fill="rgb(0,0,255)"',
      'fill="rgb(255,255,255)"',
      'fill="rgb(30, 64, 175)"',
    );
    expect(blue).toBeGreaterThan(-1);
    expect(blue).toBeLessThan(white);
    expect(white).toBeLessThan(thumb);
    // 20px thumb + 3px spread on each side = 26px, fully rounded.
    expect(svg).toMatch(/width="26" height="26" rx="13"/);
  });

  it("paints offset + blur thumb shadows with a Gaussian filter below the thumb", () => {
    const { ctx, defsParts } = defCtx();
    const svg = renderFormControl(range({ rangeThumbBoxShadow: "rgba(0, 0, 0, 0.5) 0px 2px 4px 0px" }), "", ctx);
    expect(defsParts.join("")).toContain("feGaussianBlur");
    expect(svg.indexOf('filter="url(#tgrad')).toBeGreaterThan(-1);
    expect(svg.indexOf('filter="url(#tgrad')).toBeLessThan(svg.indexOf('fill="rgb(30, 64, 175)"'));
  });

  it("paints an inset thumb shadow above the thumb, clipped to its padding box", () => {
    const { ctx, defsParts } = defCtx();
    const svg = renderFormControl(range({ rangeThumbBoxShadow: "rgb(255, 0, 0) 0px -3px 2px 0px inset" }), "", ctx);
    expect(defsParts.join("")).toContain("<clipPath");
    expect(svg.indexOf('fill-rule="evenodd"')).toBeGreaterThan(svg.indexOf('fill="rgb(30, 64, 175)"'));
  });

  it("paints the captured track box-shadow: outer below, inset above the track", () => {
    const { ctx } = defCtx();
    const svg = renderFormControl(
      range({ rangeTrackBoxShadow: "rgb(0, 128, 0) 0px 2px 0px 0px, rgb(255, 0, 0) 0px 1px 2px 0px inset" }),
      "",
      ctx,
    );
    const [outer, track, inset] = order(svg, 'fill="rgb(0,128,0)"', 'fill="rgb(200, 200, 200)"', 'fill-rule="evenodd"');
    expect(outer).toBeGreaterThan(-1);
    expect(outer).toBeLessThan(track);
    expect(inset).toBeGreaterThan(track);
  });

  it("paints a centered pure-blur inset glow as a blurred inner ring", () => {
    const { ctx } = defCtx();
    const svg = renderFormControl(range({ rangeThumbBoxShadow: "rgb(255, 0, 0) 0px 0px 4px 0px inset" }), "", ctx);
    expect(svg).toMatch(/fill="none" stroke="rgb\(255,0,0\)" stroke-width="2"/);
  });

  it("emits nothing extra without a shadow", () => {
    const { ctx } = defCtx();
    const svg = renderFormControl(range({}), "", ctx);
    expect(svg).not.toContain("filter=");
    expect(svg).not.toContain("evenodd");
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
      fontAscent: 11,
      fontDescent: 3,
      styles: {
        effectiveAppearance: "none",
        selectDisplayText: "Choose…",
        fontFamily: `-apple-system, "Segoe UI", system-ui, sans-serif`,
        fontSize: "13",
        fontWeight: "400",
        color: "rgb(0,0,0)",
        paddingLeft: "0",
        paddingTop: "0",
        paddingBottom: "0",
        borderLeftWidth: "0",
        borderTopWidth: "0",
        borderBottomWidth: "0",
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
      x: 44,
      y: 263,
      width: 740,
      height: 132,
      styles: {
        fontSize: "16",
        color: "rgb(0,0,0)",
        paddingLeft: "0",
        borderLeftWidth: "1",
        paddingTop: "0",
        borderTopWidth: "1",
        summaryMarkerSuppressed: true,
        detailsOpen: true,
        ...(box ? { detailsContentBox: box } : {}),
      },
      children: [{ tag: "summary", x: 44, y: 264, width: 740, height: 47, styles: {} }],
    } as unknown as Parameters<typeof renderFormControl>[0];
  }

  it("paints a 1px divider at the summary's bottom edge when ::details-content has a border-top", () => {
    const svg = renderFormControl(
      makeOpenDetails({
        borderTopWidth: 1,
        borderTopColor: "rgb(226, 232, 240)",
        paddingBottom: 0,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
      }),
      "",
    );
    // Divider at summary.y + summary.height = 264 + 47 = 311, full content width.
    expect(svg).toContain('y="311"');
    expect(svg).toContain('height="1"');
    expect(svg).toContain('fill="rgb(226, 232, 240)"');
  });

  it("paints the divider even when the summary marker is suppressed (list-style:none idiom)", () => {
    // The accordion pattern hides the UA triangle; the separator must still show.
    const svg = renderFormControl(
      makeOpenDetails({
        borderTopWidth: 1,
        borderTopColor: "rgb(226, 232, 240)",
        paddingBottom: 0,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
      }),
      "",
    );
    expect(svg).toContain('fill="rgb(226, 232, 240)"');
  });

  it("paints nothing extra when ::details-content carries no border (no detailsContentBox)", () => {
    const svg = renderFormControl(makeOpenDetails(undefined), "");
    expect(svg).not.toContain('fill="rgb(226, 232, 240)"');
  });
});

describe("source-owned structural <meter> geometry (DM-1156 / DM-2458)", () => {
  function makeMeter(styles: Record<string, unknown>): Parameters<typeof renderFormControl>[0] {
    return {
      tag: "meter",
      x: 264,
      y: 100,
      width: 528,
      height: 16,
      styles: {
        effectiveAppearance: "none",
        meterValue: 9,
        meterMin: 0,
        meterMax: 10,
        meterLow: 3,
        meterHigh: 7,
        meterOptimum: 8,
        meterBarBg: "rgb(12, 34, 56)",
        meterOptimumBg: "rgb(78, 90, 12)",
        ...styles,
      },
    } as unknown as Parameters<typeof renderFormControl>[0];
  }

  it("does not paint the retired sampled native groove", () => {
    const svg = renderFormControl(makeMeter({}), "");
    expect(svg).toContain('fill="rgb(12, 34, 56)"');
    expect(svg).toContain('fill="rgb(78, 90, 12)"');
    expect(svg).not.toContain("stroke=");
    expect(svg).not.toContain("rgb(203,203,203)");
  });

  it("keeps the captured author radius", () => {
    const svg = renderFormControl(makeMeter({ meterBarRadius: "8px" }), "");
    expect(svg).not.toContain('stroke="rgb(203,203,203)"');
    // The pill track keeps its author radius.
    expect(svg).toContain('rx="8"');
  });

  it("uses Blink html.css's structural 1fr/2fr/1fr value grid", () => {
    // The source-owned structural pseudo uses the center half of the track: for a
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
    const svg = renderFormControl(
      makeDetails({
        summaryMarkerSuppressed: false,
        summaryMarkerColor: "rgb(109,40,217)",
        summaryMarkerFontSize: 28,
        summaryMarkerInside: true,
      }),
      "",
    );
    expect(svg).toBe("");
    expect(svg).not.toContain("<polygon");
  });
});
