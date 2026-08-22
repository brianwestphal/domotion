import { describe, expect, it } from "vitest";
import {
  controlPseudoKindForNode,
  dynamicScrollbarPseudoKindsFromCss,
  hasAuthorPseudoOrigin,
  resolvedControlPseudoStyle,
} from "./pseudo-style-cdp.js";

describe("Chromium-resolved control pseudo capture", () => {
  it("maps Blink UA-shadow pseudo identities, including the id-only range thumb", () => {
    const rows = [
      ["-webkit-slider-runnable-track", "track"],
      ["-webkit-progress-bar", "progress-bar"],
      ["-webkit-progress-value", "progress-value"],
      ["-webkit-meter-bar", "meter-bar"],
      ["-webkit-meter-optimum-value", "meter-optimum"],
      ["-webkit-meter-suboptimum-value", "meter-suboptimum"],
      ["-webkit-meter-even-less-good-value", "meter-even-less-good"],
      ["-webkit-color-swatch", "color-swatch"],
      ["-webkit-color-swatch-wrapper", "color-swatch-wrapper"],
      ["-webkit-inner-spin-button", "inner-spin-button"],
      ["-webkit-search-cancel-button", "search-cancel-button"],
      ["-webkit-calendar-picker-indicator", "calendar-picker-indicator"],
      ["-internal-select-inner-element", "select-inner"],
      ["-webkit-file-upload-button", "file-selector-button"],
    ] as const;
    for (const [pseudo, kind] of rows) {
      expect(controlPseudoKindForNode({ pseudo }, "INPUT", { type: "range" })).toBe(kind);
    }
    expect(controlPseudoKindForNode(
      { id: "thumb" },
      "INPUT",
      { type: "RANGE" },
    )).toBe("thumb");
    expect(controlPseudoKindForNode({ id: "thumb" }, "DIV", {})).toBeNull();
    expect(controlPseudoKindForNode(
      { "aria-hidden": "true" }, "INPUT", { type: "file" }, "SPAN",
    )).toBe("file-selector-status");
    expect(controlPseudoKindForNode(
      { "aria-hidden": "true" }, "INPUT", { type: "text" }, "SPAN",
    )).toBeNull();
  });

  it("classifies UA-only rules as native and every non-UA direct origin as authored", () => {
    expect(hasAuthorPseudoOrigin([])).toBe(false);
    expect(hasAuthorPseudoOrigin(["user-agent", "user-agent"])).toBe(false);
    expect(hasAuthorPseudoOrigin(["user-agent", "regular"])).toBe(true);
    expect(hasAuthorPseudoOrigin(["injected", "user-agent"])).toBe(true);
  });

  it("detects stateful anonymous scrollbar winners without replaying their cascade", () => {
    const kinds = dynamicScrollbarPseudoKindsFromCss([
      `
        .box::-webkit-scrollbar-thumb:vertical:hover { background: red }
        .box::-webkit-scrollbar-track-piece:start { background: blue }
        .box::-webkit-scrollbar-button:increment { display: block }
        .box::-webkit-scrollbar-corner { background: green }
      `,
    ]);
    expect([...kinds].sort()).toEqual([
      "scrollbar-button",
      "scrollbar-thumb",
      "scrollbar-track-piece",
    ]);
  });

  it("serializes final longhands after Blink resolves shorthand/longhand competition", () => {
    const style = resolvedControlPseudoStyle([
      { name: "width", value: "21px" },
      { name: "height", value: "17px" },
      { name: "background-color", value: "rgb(1, 2, 3)" },
      { name: "background-image", value: "linear-gradient(rgb(4, 5, 6), rgb(7, 8, 9))" },
      { name: "border-top-width", value: "3px" },
      { name: "border-top-style", value: "solid" },
      { name: "border-top-color", value: "rgb(10, 11, 12)" },
      { name: "border-right-width", value: "3px" },
      { name: "border-right-style", value: "solid" },
      { name: "border-right-color", value: "rgb(10, 11, 12)" },
      { name: "border-bottom-width", value: "3px" },
      { name: "border-bottom-style", value: "solid" },
      { name: "border-bottom-color", value: "rgb(10, 11, 12)" },
      { name: "border-left-width", value: "3px" },
      { name: "border-left-style", value: "solid" },
      { name: "border-left-color", value: "rgb(10, 11, 12)" },
      { name: "border-top-left-radius", value: "1px 5px" },
      { name: "border-top-right-radius", value: "2px 6px" },
      { name: "border-bottom-right-radius", value: "3px 7px" },
      { name: "border-bottom-left-radius", value: "4px 8px" },
      { name: "padding-top", value: "1px" },
      { name: "padding-right", value: "2px" },
      { name: "padding-bottom", value: "3px" },
      { name: "padding-left", value: "2px" },
      { name: "box-shadow", value: "rgb(13, 14, 15) 0px 0px 0px 2px" },
    ]);

    expect(style).toEqual({
      matched: true,
      display: "",
      visibility: "",
      opacity: "",
      width: "21px",
      height: "17px",
      minWidth: "",
      minHeight: "",
      maxWidth: "",
      maxHeight: "",
      marginTop: "",
      marginRight: "",
      marginBottom: "",
      marginLeft: "",
      backgroundColor: "rgb(1, 2, 3)",
      backgroundImage: "linear-gradient(rgb(4, 5, 6), rgb(7, 8, 9))",
      borderRadius: "1px 2px 3px 4px / 5px 6px 7px 8px",
      border: "3px solid rgb(10, 11, 12)",
      padding: "1px 2px 3px",
      boxShadow: "rgb(13, 14, 15) 0px 0px 0px 2px",
      filter: "",
    });
  });

  it("does not turn asymmetric or absent borders into a false uniform stroke", () => {
    const style = resolvedControlPseudoStyle([
      { name: "background-image", value: "none" },
      { name: "box-shadow", value: "none" },
      { name: "border-top-width", value: "1px" },
      { name: "border-top-style", value: "solid" },
      { name: "border-top-color", value: "red" },
      { name: "border-right-width", value: "0px" },
      { name: "border-right-style", value: "none" },
      { name: "border-right-color", value: "red" },
      { name: "border-bottom-width", value: "0px" },
      { name: "border-bottom-style", value: "none" },
      { name: "border-bottom-color", value: "red" },
      { name: "border-left-width", value: "0px" },
      { name: "border-left-style", value: "none" },
      { name: "border-left-color", value: "red" },
      { name: "padding-top", value: "0px" },
      { name: "padding-right", value: "0px" },
      { name: "padding-bottom", value: "0px" },
      { name: "padding-left", value: "0px" },
    ]);
    expect(style.backgroundImage).toBe("");
    expect(style.boxShadow).toBe("");
    expect(style.border).toBe("");
    expect(style.borderSides).toEqual({
      top: { width: "1px", style: "solid", color: "red" },
      right: { width: "0px", style: "none", color: "red" },
      bottom: { width: "0px", style: "none", color: "red" },
      left: { width: "0px", style: "none", color: "red" },
    });
    expect(style.padding).toBe("0px");
  });
});
