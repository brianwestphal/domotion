// Pins the transcription of Blink's Windows family-name suffix adjustment
// (`TypefacesHasWeightSuffix` / `TypefacesHasStretchSuffix`,
// `platform/fonts/win/font_cache_skia_win.cc:335-407`, rev 7d859f27) — the
// layer that resolves "Segoe UI Light" as "Segoe UI" with the weight PINNED at
// 300. Measured live against Chrome over CDP on Windows 11: without this layer
// every style-suffixed family was 84 of 84 conformance misses; with it the
// sweep scores 516/516.
import { describe, expect, it } from "vitest";
import { win32FamilySuffixAdjustment } from "./win32-family-suffix.js";

describe("win32FamilySuffixAdjustment", () => {
  it("maps each weight suffix to the weight Blink pins", () => {
    const rows: Array<[string, string, number]> = [
      ["Segoe UI Thin", "Segoe UI", 100],
      ["Segoe UI ExtraLight", "Segoe UI", 200],
      ["Kozuka Gothic UltraLight", "Kozuka Gothic", 200],
      ["Segoe UI Light", "Segoe UI", 300],
      ["Roboto Regular", "Roboto", 400],
      ["Franklin Gothic Medium", "Franklin Gothic", 500],
      ["Franklin Gothic DemiBold", "Franklin Gothic", 600],
      ["Segoe UI Semibold", "Segoe UI", 600],
      ["Segoe UI ExtraBold", "Segoe UI", 800],
      ["Gotham UltraBold", "Gotham", 800],
      ["Segoe UI Black", "Segoe UI", 900],
      ["Helvetica Heavy", "Helvetica", 900],
    ];
    for (const [name, family, weight] of rows) {
      expect(win32FamilySuffixAdjustment(name), name).toEqual({ family, weight });
    }
  });

  it("maps each stretch suffix — Narrow deliberately a synonym for Condensed", () => {
    expect(win32FamilySuffixAdjustment("Arial Narrow")).toEqual({ family: "Arial", stretch: 75 });
    expect(win32FamilySuffixAdjustment("Foo Condensed")).toEqual({ family: "Foo", stretch: 75 });
    expect(win32FamilySuffixAdjustment("Foo UltraCondensed")).toEqual({ family: "Foo", stretch: 50 });
    expect(win32FamilySuffixAdjustment("Foo ExtraCondensed")).toEqual({ family: "Foo", stretch: 62.5 });
    expect(win32FamilySuffixAdjustment("Foo SemiCondensed")).toEqual({ family: "Foo", stretch: 87.5 });
    expect(win32FamilySuffixAdjustment("Foo SemiExpanded")).toEqual({ family: "Foo", stretch: 112.5 });
    expect(win32FamilySuffixAdjustment("Foo Expanded")).toEqual({ family: "Foo", stretch: 125 });
    expect(win32FamilySuffixAdjustment("Foo ExtraExpanded")).toEqual({ family: "Foo", stretch: 150 });
    expect(win32FamilySuffixAdjustment("Foo UltraExpanded")).toEqual({ family: "Foo", stretch: 200 });
  });

  it("is case-insensitive on the suffix but preserves the family's own casing", () => {
    expect(win32FamilySuffixAdjustment("SEGOE UI LIGHT")).toEqual({ family: "SEGOE UI", weight: 300 });
    expect(win32FamilySuffixAdjustment("segoe ui light")).toEqual({ family: "segoe ui", weight: 300 });
  });

  it("strips exactly one suffix — Blink does not recurse", () => {
    // " light" matches first; the remaining name keeps its own words.
    expect(win32FamilySuffixAdjustment("Foo Condensed Light")).toEqual({ family: "Foo Condensed", weight: 300 });
  });

  it("requires a word boundary — the suffix table entries start with a space", () => {
    expect(win32FamilySuffixAdjustment("Twilight")).toBeNull();
    expect(win32FamilySuffixAdjustment("Moonblack")).toBeNull();
  });

  it("does not recognize suffixes outside Blink's deliberately-incomplete table", () => {
    // Upstream keeps this list short for GDI backward compatibility
    // (crrev.com/c/542603004); "completing" it here would diverge from Chrome.
    expect(win32FamilySuffixAdjustment("Segoe UI Semilight")).toBeNull();
    expect(win32FamilySuffixAdjustment("Yu Gothic UI Semilight")).toBeNull();
    expect(win32FamilySuffixAdjustment("Foo Bold")).toBeNull();
    expect(win32FamilySuffixAdjustment("Foo Italic")).toBeNull();
  });

  it("answers null for plain family names", () => {
    expect(win32FamilySuffixAdjustment("Segoe UI")).toBeNull();
    expect(win32FamilySuffixAdjustment("Arial")).toBeNull();
    expect(win32FamilySuffixAdjustment("")).toBeNull();
  });
});
