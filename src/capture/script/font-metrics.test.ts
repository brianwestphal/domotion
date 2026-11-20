// @vitest-environment happy-dom
// Which question the capture's baseline-metric probe asks. A kStandardFamily
// element, or a generic keyword with an explicit locale, resolves its primary
// font through `settings.<generic>(script)` in Blink
// (`platform/fonts/font_selector.cc:20-80`, Chromium 7d859f27); a detached
// canvas sees neither the family type nor the locale, so those are measured
// with an in-document probe. Real-Chromium coverage:
// tests/standard-family-locale-metrics.e2e.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFontMetrics } from "./font-metrics.js";

interface Seen {
  family: string;
  locale: string;
}

/** A live-style stand-in: the real capture passes `getComputedStyle(el)`. */
function liveStyle(fontFamily: string, locale: string) {
  return {
    fontStyle: "normal",
    fontWeight: "400",
    fontSize: "32px",
    fontFamily,
    getPropertyValue: (property: string) => (property === "-webkit-locale" ? locale : ""),
  };
}

describe("font metric probe selection", () => {
  let domProbes: Seen[];
  let canvasFonts: string[];
  let hostWidth: number;

  beforeEach(() => {
    domProbes = [];
    canvasFonts = [];
    hostWidth = 100;
    // DOM probe geometry: host (div) / text span / baseline inline-block.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "DIV") {
        domProbes.push({
          family: this.style.fontFamily,
          locale: this.style.getPropertyValue("-webkit-locale"),
        });
        return { top: 0, bottom: 48, left: 0, right: hostWidth, width: hostWidth, height: 48 } as DOMRect;
      }
      if (this.style.display === "inline-block") return { top: 28, bottom: 28, height: 0, width: 0 } as DOMRect;
      return { top: 0, bottom: 32, height: 32, width: 50 } as DOMRect;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
      const ctx = {
        font: "",
        measureText: () => {
          canvasFonts.push(ctx.font);
          return { fontBoundingBoxAscent: 29, fontBoundingBoxDescent: 8 };
        },
      };
      return ctx as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement["getContext"]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("measures a kStandardFamily style as the standard family in its locale", () => {
    const metrics = createFontMetrics();
    const cs = liveStyle("Times", '"ja"');
    metrics.markStandardFamilyStyle(cs);
    expect(metrics.measureFontMetrics(cs)).toEqual({ ascent: 28, descent: 4 });
    expect(domProbes).toEqual([{ family: "initial", locale: '"ja"' }]);
    expect(canvasFonts).toEqual([]);
  });

  it("does not let a literal family share the standard family's cached answer", () => {
    const metrics = createFontMetrics();
    const standard = liveStyle("Times", '"ja"');
    metrics.markStandardFamilyStyle(standard);
    metrics.measureFontMetrics(standard);
    expect(metrics.measureFontMetrics(liveStyle("Times", '"ja"'))).toEqual({ ascent: 29, descent: 8 });
    expect(canvasFonts).toEqual(["normal 400 32px Times"]);
  });

  it("measures a generic keyword with an explicit locale in the document", () => {
    const metrics = createFontMetrics();
    expect(metrics.measureFontMetrics(liveStyle("Foo, serif", '"ja"'))).toEqual({ ascent: 28, descent: 4 });
    expect(domProbes).toEqual([{ family: "Foo, serif", locale: '"ja"' }]);
  });

  it.each([
    ["a concrete family with an explicit locale", liveStyle("Times", '"ja"')],
    ["a generic keyword in the default locale", liveStyle("serif", "auto")],
    [
      "a synthetic style record",
      { fontStyle: "normal", fontWeight: "400", fontSize: "32px", fontFamily: "serif" } as ReturnType<typeof liveStyle>,
    ],
  ])("keeps the canvas probe for %s", (_name, cs) => {
    const metrics = createFontMetrics();
    expect(metrics.measureFontMetrics(cs)).toEqual({ ascent: 29, descent: 8 });
    expect(domProbes).toEqual([]);
  });

  it("falls back to the canvas when an inherited zoom scales the DOM probe", () => {
    hostWidth = 150;
    const metrics = createFontMetrics();
    const cs = liveStyle("Times", '"ja"');
    metrics.markStandardFamilyStyle(cs);
    expect(metrics.measureFontMetrics(cs)).toEqual({ ascent: 29, descent: 8 });
    expect(domProbes).toHaveLength(1);
  });

  it("measures normal line spacing for the standard family in its locale", () => {
    const metrics = createFontMetrics();
    const cs = liveStyle("Times", '"ja"');
    metrics.markStandardFamilyStyle(cs);
    expect(metrics.measureNormalLineSpacing(cs)).toBe(48);
    expect(domProbes).toEqual([{ family: "initial", locale: '"ja"' }]);
  });
});
