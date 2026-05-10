import { describe, expect, it } from "vitest";
import { rootSvgColorSchemeAttr, wrapSvg, type CapturedElement } from "./dom-to-svg.js";

// DM-552: capture-side propagation of `rootColorScheme` and `rootBgComputed`
// stamped on the captured tree's root element by CAPTURE_SCRIPT, plus the
// renderer-side helper that emits `color-scheme="dark"` on the wrapping
// `<svg>` element. End-to-end CAPTURE_SCRIPT integration is covered by
// the real-world suite + the dark-mode form-control fixture (DM-553); this
// file unit-tests the renderer-side surface in isolation.

function makeRoot(overrides: { rootColorScheme?: "light" | "dark"; rootBgComputed?: string } = {}): CapturedElement {
  return {
    tag: "body",
    text: "",
    x: 0, y: 0, width: 100, height: 100,
    children: [],
    styles: {
      backgroundColor: "rgb(255,255,255)",
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
      color: "rgb(0,0,0)",
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
      ...overrides,
    } as any,
  };
}

describe("rootSvgColorSchemeAttr (DM-552)", () => {
  it("returns empty string when the captured tree is empty", () => {
    expect(rootSvgColorSchemeAttr([])).toBe("");
  });

  it("returns empty string when rootColorScheme is undefined (default scheme is attribute-free — today's SVG byte-identical)", () => {
    expect(rootSvgColorSchemeAttr([makeRoot()])).toBe("");
  });

  it("returns empty string when rootColorScheme is explicitly 'light'", () => {
    expect(rootSvgColorSchemeAttr([makeRoot({ rootColorScheme: "light" })])).toBe("");
  });

  it("returns ` color-scheme=\"dark\"` (with leading space, ready to concat) when rootColorScheme is 'dark'", () => {
    expect(rootSvgColorSchemeAttr([makeRoot({ rootColorScheme: "dark" })])).toBe(` color-scheme="dark"`);
  });

  it("only inspects elements[0] — siblings with mismatched scheme are ignored (only the root carries the page-level signal)", () => {
    const root = makeRoot({ rootColorScheme: "light" });
    const sibling = makeRoot({ rootColorScheme: "dark" });
    expect(rootSvgColorSchemeAttr([root, sibling])).toBe("");
  });
});

describe("wrapSvg with tree option (DM-552)", () => {
  it("emits a vanilla <svg> when no tree is passed (back-compat)", () => {
    const out = wrapSvg("<g/>", 100, 50);
    expect(out).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><g/></svg>`);
  });

  it("emits a vanilla <svg> when the tree's root has no rootColorScheme", () => {
    const out = wrapSvg("<g/>", 100, 50, { tree: [makeRoot()] });
    expect(out).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><g/></svg>`);
  });

  it("includes color-scheme=\"dark\" on the root <svg> when tree's root reports dark scheme", () => {
    const out = wrapSvg("<g/>", 100, 50, { tree: [makeRoot({ rootColorScheme: "dark" })] });
    expect(out).toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50" color-scheme="dark"><g/></svg>`);
  });

  it("does NOT add color-scheme=\"light\" — the absence of the attribute IS the light default (today's output preserved verbatim)", () => {
    const out = wrapSvg("<g/>", 100, 50, { tree: [makeRoot({ rootColorScheme: "light" })] });
    expect(out).not.toContain("color-scheme");
  });
});
