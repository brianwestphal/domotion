import { describe, expect, it } from "vitest";

import {
  decorationFingerprintMatches,
  nativeControlDecorationKinds,
} from "./native-control-decoration.js";

describe("partial native-control decoration ownership", () => {
  it("splits only the styled menulist and keeps complete/base select routes intact", () => {
    const select = { tag: "select" };
    expect(nativeControlDecorationKinds(select, "menulist")).toEqual([]);
    expect(nativeControlDecorationKinds(select, "menulist-button"))
      .toEqual(["menulist-button-arrow"]);
    expect(nativeControlDecorationKinds(select, "listbox")).toEqual([]);
    expect(nativeControlDecorationKinds(select, "base-select")).toEqual([]);
    expect(nativeControlDecorationKinds(select, null)).toEqual([]);
  });

  it("routes only partial number/search/temporal UA-shadow decorations", () => {
    expect(nativeControlDecorationKinds({ tag: "input", type: "number" }, "none"))
      .toEqual(["inner-spin-button"]);
    expect(nativeControlDecorationKinds({ tag: "input", type: "search" }, "none"))
      .toEqual(["search-cancel-button"]);
    for (const type of ["date", "datetime-local", "month", "time", "week"]) {
      expect(nativeControlDecorationKinds({ tag: "input", type }, "none"))
        .toEqual(["calendar-picker-indicator"]);
    }
    expect(nativeControlDecorationKinds({ tag: "input", type: "number" }, "textfield"))
      .toEqual([]);
    expect(nativeControlDecorationKinds({ tag: "input", type: "text" }, "none"))
      .toEqual([]);
    expect(nativeControlDecorationKinds({ tag: "input", type: "search" }, "base"))
      .toEqual([]);
  });

  it("uses the real file-selector child's EffectiveAppearance, not the file host", () => {
    const file = { tag: "input", type: "file" };
    expect(nativeControlDecorationKinds(file, "none", "push-button"))
      .toEqual(["file-selector-button"]);
    expect(nativeControlDecorationKinds(file, "none", null))
      .toEqual(["file-selector-button"]);
    expect(nativeControlDecorationKinds(file, "none", undefined))
      .toEqual(["file-selector-button"]);
    expect(nativeControlDecorationKinds(file, "none", "none")).toEqual([]);
    expect(nativeControlDecorationKinds(file, "none", "base-select")).toEqual([]);
  });

  it("fails closed when a pierced part changes identity, geometry, or validity", () => {
    const expected = { kind: "inner-spin-button" as const, x: 100.25, y: 20, width: 15, height: 18 };
    expect(decorationFingerprintMatches(expected, { ...expected, x: 100.4 })).toBe(true);
    expect(decorationFingerprintMatches(expected, { ...expected, x: 100.6 })).toBe(false);
    expect(decorationFingerprintMatches(expected, { ...expected, kind: "search-cancel-button" })).toBe(false);
    expect(decorationFingerprintMatches(expected, { ...expected, width: 0 })).toBe(false);
    expect(decorationFingerprintMatches(expected, { ...expected, x: Number.NaN })).toBe(false);
  });
});
