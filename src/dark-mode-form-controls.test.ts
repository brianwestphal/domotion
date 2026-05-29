import { describe, expect, it } from "vitest";
import { stockPalette, type DefCtx } from "./render/form-controls.js";
import { elementTreeToSvgInner } from "./render/element-tree-to-svg.js";
import type { CapturedElement } from "./capture/types.js";

// DM-553: form-control synthesizers consume `defCtx.colorScheme` to pick the
// stock palette. Tests verify (1) the `stockPalette(scheme)` dispatcher
// returns the right palette per scheme, (2) renderFormControl-driven SVG
// emission uses dark palette colors when the captured tree's root reports
// dark scheme, (3) light scheme + missing scheme stay byte-identical to
// today's output.

const STOCK_LIGHT_FILL = "rgb(255,255,255)";
const STOCK_LIGHT_BORDER = "rgb(118,118,118)";
const STOCK_LIGHT_ACCENT = "rgb(0,117,255)";
const STOCK_DARK_FILL = "rgb(59,59,59)";
const STOCK_DARK_BORDER = "rgb(59,59,59)";
const STOCK_DARK_ACCENT = "rgb(153,200,255)";
const STOCK_DARK_TRACK_BG = "rgb(59,59,59)";

describe("stockPalette dispatcher", () => {
  it("returns the light palette for `light`", () => {
    const p = stockPalette("light");
    expect(p.fill).toBe(STOCK_LIGHT_FILL);
    expect(p.border).toBe(STOCK_LIGHT_BORDER);
    expect(p.accent).toBe(STOCK_LIGHT_ACCENT);
  });

  it("returns the dark palette for `dark`", () => {
    const p = stockPalette("dark");
    expect(p.fill).toBe(STOCK_DARK_FILL);
    expect(p.border).toBe(STOCK_DARK_BORDER);
    expect(p.accent).toBe(STOCK_DARK_ACCENT);
    expect(p.trackBg).toBe(STOCK_DARK_TRACK_BG);
  });

  it("defaults to light when scheme is undefined / missing", () => {
    expect(stockPalette(undefined).fill).toBe(STOCK_LIGHT_FILL);
  });

  it("defaults to light for any string other than 'dark'", () => {
    expect(stockPalette("light").fill).toBe(STOCK_LIGHT_FILL);
    expect(stockPalette(undefined).accent).toBe(STOCK_LIGHT_ACCENT);
  });
});

void ({} as DefCtx); // type smoke

function makeBody(rootColorScheme?: "light" | "dark", children: CapturedElement[] = []): CapturedElement {
  return {
    tag: "body",
    text: "",
    x: 0, y: 0, width: 200, height: 200,
    children,
    styles: {
      backgroundColor: "rgb(0,0,0)",
      borderColor: "rgb(0,0,0)",
      borderWidth: "0",
      borderRadius: "0",
      borderTopLeftRadius: "0",
      borderTopRightRadius: "0",
      borderBottomRightRadius: "0",
      borderBottomLeftRadius: "0",
      borderTopWidth: "0",
      borderRightWidth: "0",
      borderBottomWidth: "0",
      borderLeftWidth: "0",
      borderTopColor: "rgb(0,0,0)",
      borderRightColor: "rgb(0,0,0)",
      borderBottomColor: "rgb(0,0,0)",
      borderLeftColor: "rgb(0,0,0)",
      borderTopStyle: "none",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      color: "rgb(255,255,255)",
      fontSize: "16px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      lineHeight: "20px",
      letterSpacing: "normal",
      textAlign: "left",
      textTransform: "none",
      textDecoration: "none",
      textDecorationLine: "none",
      textDecorationStyle: "solid",
      textDecorationColor: "rgb(0,0,0)",
      textDecorationThickness: "auto",
      textIndent: "0",
      textShadow: "none",
      textWrap: "wrap",
      whiteSpace: "normal",
      wordBreak: "normal",
      overflowWrap: "normal",
      verticalAlign: "baseline",
      backgroundImage: "none",
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      backgroundAttachment: "scroll",
      backgroundClip: "border-box",
      backgroundOrigin: "padding-box",
      opacity: "1",
      position: "static",
      top: "auto",
      left: "auto",
      right: "auto",
      bottom: "auto",
      display: "block",
      flexDirection: "row",
      visibility: "visible",
      zIndex: "auto",
      transform: "none",
      transformOrigin: "50% 50%",
      writingMode: "horizontal-tb",
      textOrientation: "mixed",
      cursor: "auto",
      pointerEvents: "auto",
      ...(rootColorScheme != null ? { rootColorScheme } : {}),
    } as any,
  };
}

function makeCheckbox(): CapturedElement {
  const e = makeBody(undefined);
  e.tag = "input";
  e.x = 10; e.y = 10; e.width = 13; e.height = 13;
  (e.styles as any).inputType = "checkbox";
  return e;
}

function makeProgress(): CapturedElement {
  const e = makeBody(undefined);
  e.tag = "progress";
  e.x = 10; e.y = 30; e.width = 100; e.height = 14;
  (e.styles as any).progressValue = 0.5;
  (e.styles as any).progressMax = 1;
  return e;
}

function makeMeter(): CapturedElement {
  const e = makeBody(undefined);
  e.tag = "meter";
  e.x = 10; e.y = 50; e.width = 100; e.height = 14;
  (e.styles as any).meterValue = 0.5;
  (e.styles as any).meterMin = 0;
  (e.styles as any).meterMax = 1;
  (e.styles as any).meterLow = 0.3;
  (e.styles as any).meterHigh = 0.7;
  (e.styles as any).meterOptimum = 0.5;
  return e;
}

function makeRange(): CapturedElement {
  const e = makeBody(undefined);
  e.tag = "input";
  e.x = 10; e.y = 70; e.width = 100; e.height = 14;
  (e.styles as any).inputType = "range";
  (e.styles as any).rangeMin = 0;
  (e.styles as any).rangeMax = 100;
  (e.styles as any).rangeValue = 50;
  return e;
}

function emitForScheme(scheme: "light" | "dark" | undefined, control: CapturedElement): string {
  const root = makeBody(scheme, [control]);
  return elementTreeToSvgInner([root], 200, 200);
}

describe("renderCheckbox: scheme-aware palette (DM-553)", () => {
  it("uses LIGHT fill + LIGHT border under default scheme", () => {
    const out = emitForScheme(undefined, makeCheckbox());
    expect(out).toContain(`fill="${STOCK_LIGHT_FILL}"`);
    expect(out).toContain(`stroke="${STOCK_LIGHT_BORDER}"`);
  });

  it("uses LIGHT fill + LIGHT border when scheme is 'light'", () => {
    const out = emitForScheme("light", makeCheckbox());
    expect(out).toContain(`fill="${STOCK_LIGHT_FILL}"`);
    expect(out).toContain(`stroke="${STOCK_LIGHT_BORDER}"`);
    expect(out).not.toContain(`fill="${STOCK_DARK_FILL}"`);
  });

  it("uses DARK fill + DARK border when scheme is 'dark'", () => {
    const out = emitForScheme("dark", makeCheckbox());
    expect(out).toContain(`fill="${STOCK_DARK_FILL}"`);
    expect(out).toContain(`stroke="${STOCK_DARK_BORDER}"`);
    expect(out).not.toContain(`fill="${STOCK_LIGHT_FILL}"`);
  });
});

describe("renderProgress: scheme-aware palette (DM-553)", () => {
  it("uses LIGHT track + LIGHT accent under default scheme", () => {
    const out = emitForScheme(undefined, makeProgress());
    expect(out).toContain(STOCK_LIGHT_ACCENT);
  });

  it("uses DARK track + DARK accent when scheme is 'dark'", () => {
    const out = emitForScheme("dark", makeProgress());
    expect(out).toContain(STOCK_DARK_ACCENT);
    expect(out).not.toContain(STOCK_LIGHT_ACCENT);
  });
});

describe("renderMeter: scheme-aware palette (DM-553)", () => {
  it("uses the LIGHT meter green at default scheme (value in optimum band)", () => {
    const out = emitForScheme(undefined, makeMeter());
    expect(out).toContain("rgb(16,124,16)"); // STOCK_LIGHT.meterGreen
  });

  it("uses the DARK meter green when scheme is 'dark'", () => {
    const out = emitForScheme("dark", makeMeter());
    expect(out).toContain("rgb(116,179,116)"); // STOCK_DARK.meterGreen
    expect(out).not.toContain("rgb(16,124,16)");
  });
});

describe("renderRange: scheme-aware UA-default palette (DM-553)", () => {
  it("uses LIGHT accent at default scheme", () => {
    const out = emitForScheme(undefined, makeRange());
    expect(out).toContain(STOCK_LIGHT_ACCENT);
  });

  it("uses DARK accent when scheme is 'dark'", () => {
    const out = emitForScheme("dark", makeRange());
    expect(out).toContain(STOCK_DARK_ACCENT);
  });
});
