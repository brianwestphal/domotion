import { describe, expect, it } from "vitest";
import {
  authorControlStyleFactsFromMatchedStyles,
  autoAppearanceForControl,
  effectiveAppearanceForControl,
  isWholeHostNativeAppearance,
  type CdpCssPropertyLike,
} from "./effective-appearance.js";

const available = (background = false, border = false) => ({
  available: true,
  hasAuthorBackground: background,
  hasAuthorBorder: border,
});

function style(...cssProperties: CdpCssPropertyLike[]) {
  return { cssProperties };
}

function rule(
  origin: string,
  cssProperties: CdpCssPropertyLike[],
  layer?: string,
) {
  return {
    rule: {
      origin,
      style: style(...cssProperties),
      layers: layer == null ? [] : [{ text: layer }],
    },
  };
}

describe("Blink EffectiveAppearance ownership", () => {
  it("maps LayoutTheme and InputType auto appearances", () => {
    expect(autoAppearanceForControl({ tag: "button" })).toBe("button");
    expect(autoAppearanceForControl({ tag: "progress" })).toBe("progress-bar");
    expect(autoAppearanceForControl({ tag: "meter" })).toBe("meter");
    expect(autoAppearanceForControl({ tag: "textarea" })).toBe("textarea");
    expect(autoAppearanceForControl({ tag: "input", type: "submit" })).toBe("push-button");
    expect(autoAppearanceForControl({ tag: "input", type: "color" })).toBe("square-button");
    expect(autoAppearanceForControl({ tag: "input", type: "search" })).toBe("searchfield");
    expect(autoAppearanceForControl({ tag: "input", type: "number" })).toBe("textfield");
    expect(autoAppearanceForControl({ tag: "input", type: "checkbox" })).toBe("checkbox");
    expect(autoAppearanceForControl({ tag: "input", type: "radio" })).toBe("radio");
    expect(autoAppearanceForControl({ tag: "input", type: "range" })).toBe("slider-horizontal");
    expect(autoAppearanceForControl({ tag: "input", type: "file" })).toBe("none");
    expect(autoAppearanceForControl({ tag: "select", selectSize: 0 })).toBe("menulist");
    expect(autoAppearanceForControl({ tag: "select", multiple: true, selectSize: 0 })).toBe("listbox");
    expect(autoAppearanceForControl({
      tag: "select", multiple: true, selectSize: 1, selectHasSizeAttribute: true,
    })).toBe("menulist");
  });

  it("applies the exact author-background/border switches", () => {
    for (const [tag, type, expected] of [
      ["button", undefined, "button"],
      ["input", "button", "push-button"],
      ["input", "color", "square-button"],
      ["progress", undefined, "progress-bar"],
      ["meter", undefined, "meter"],
    ] as const) {
      const control = { tag, type };
      expect(effectiveAppearanceForControl("auto", control, available(), false)).toBe(expected);
      expect(effectiveAppearanceForControl("auto", control, available(true), false)).toBe("none");
      expect(effectiveAppearanceForControl("auto", control, available(false, true), false)).toBe("none");
      // LayoutTheme does not consult box-shadow for these appearances.
      expect(effectiveAppearanceForControl("auto", control, available(), true)).toBe(expected);
    }
  });

  it("turns menulist into menulist-button and opts text controls out for a shadow", () => {
    expect(effectiveAppearanceForControl(
      "auto", { tag: "select" }, available(), true,
    )).toBe("menulist-button");
    for (const control of [
      { tag: "input", type: "search" },
      { tag: "input", type: "text" },
      { tag: "textarea" },
    ]) {
      expect(effectiveAppearanceForControl("auto", control, available(), true)).toBe("none");
    }
  });

  it("keeps checkbox/radio/range native under author box styles and accent changes", () => {
    for (const type of ["checkbox", "radio", "range"]) {
      const effective = effectiveAppearanceForControl(
        "auto", { tag: "input", type }, available(true, true), true,
      );
      expect(effective).toBe(type === "range" ? "slider-horizontal" : type);
      expect(isWholeHostNativeAppearance(effective!)).toBe(true);
    }
  });

  it("applies Blink's element-type restrictions before author-style adjustment", () => {
    expect(effectiveAppearanceForControl(
      "button", { tag: "input", type: "checkbox" }, available(true, true), false,
    )).toBe("checkbox");
    expect(effectiveAppearanceForControl(
      "checkbox", { tag: "button" }, available(true, true), false,
    )).toBe("none");
    expect(effectiveAppearanceForControl(
      "button", { tag: "input", type: "submit" }, available(), false,
    )).toBe("button");
    expect(effectiveAppearanceForControl(
      "menulist-button", { tag: "select" }, available(), false,
    )).toBe("menulist-button");
    expect(effectiveAppearanceForControl(
      "textfield", { tag: "input", type: "search" }, available(), false,
    )).toBe("textfield");
  });

  it("keeps explicit none/base/base-select structurally CSS-owned", () => {
    for (const appearance of ["none", "base", "base-select"]) {
      expect(effectiveAppearanceForControl(
        appearance, { tag: "button" }, undefined, true,
      )).toBe(appearance);
      expect(isWholeHostNativeAppearance(appearance)).toBe(false);
    }
    expect(isWholeHostNativeAppearance("menulist-button")).toBe(false);
  });

  it("returns unavailable only when an appearance actually needs author flags", () => {
    expect(effectiveAppearanceForControl("auto", { tag: "button" }, undefined, false)).toBeNull();
    expect(effectiveAppearanceForControl("auto", { tag: "input", type: "checkbox" }, undefined, false)).toBe("checkbox");
    expect(effectiveAppearanceForControl("none", { tag: "button" }, undefined, false)).toBe("none");
  });
});

describe("Blink author background/border cascade flags", () => {
  it("counts only winning author-origin background and border longhands", () => {
    const facts = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [
        rule("user-agent", [{ name: "background-color", value: "buttonface" }]),
        rule("injected", [{ name: "border-left-color", value: "green" }]),
        rule("regular", [{ name: "background-image", value: "unset" }]),
      ],
    });
    expect(facts).toEqual(available(true, false));
  });

  it("expands shorthands and preserves inline author origin", () => {
    expect(authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [],
      inlineStyle: style({
        name: "background",
        value: "red",
        longhandProperties: [{ name: "background-color", value: "red" }],
      }),
    })).toEqual(available(true, false));
    expect(authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [rule("regular", [{
        name: "border",
        value: "1px solid red",
        longhandProperties: [{ name: "border-top-width", value: "1px" }],
      }])],
    })).toEqual(available(false, true));
  });

  it("does not confuse font/color/padding/text-shadow with theme box ownership", () => {
    const facts = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [rule("regular", [
        { name: "font", value: "20px sans-serif" },
        { name: "color", value: "red" },
        { name: "padding", value: "20px" },
        { name: "text-shadow", value: "0 0 2px red" },
      ])],
    });
    expect(facts).toEqual(available(false, false));
  });

  it("resolves author revert to the lower non-author origin", () => {
    const facts = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [
        rule("user-agent", [
          { name: "background-color", value: "buttonface" },
          { name: "border-top-color", value: "buttonborder" },
        ]),
        rule("regular", [
          { name: "background-color", value: "revert" },
          { name: "border-top-color", value: "revert" },
        ]),
      ],
    });
    expect(facts).toEqual(available(false, false));
  });

  it("resolves layers and important layer inversion before collecting origin", () => {
    const normalRevertLayer = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [
        rule("user-agent", [{ name: "background-color", value: "buttonface" }]),
        rule("regular", [{ name: "background-color", value: "red" }], "low"),
        rule("regular", [{ name: "background-color", value: "revert-layer" }], "high"),
      ],
    });
    expect(normalRevertLayer).toEqual(available(true, false));

    const important = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [
        rule("regular", [{ name: "border-top-color", value: "red", important: true }], "low"),
        rule("regular", [{ name: "border-top-color", value: "revert", important: true }], "high"),
      ],
    });
    // Important layer order is reversed: the earlier `low` layer wins.
    expect(important).toEqual(available(false, true));
  });

  it("maps logical border winners through direction and writing mode", () => {
    const facts = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [rule("regular", [
        { name: "border-inline-start-color", value: "red" },
        { name: "border-start-end-radius", value: "3px" },
      ])],
    }, { direction: "rtl", writingMode: "vertical-rl" });
    expect(facts).toEqual(available(false, true));
  });

  it("lets active animation/transition origins suppress only the longhand they win", () => {
    const animatedOnly = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [rule("regular", [{ name: "background-color", value: "red" }])],
      animationStyles: [{ style: style({ name: "background-color", value: "blue" }) }],
    });
    expect(animatedOnly).toEqual(available(false, false));

    const otherAuthorLonghand = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [rule("regular", [
        { name: "background-color", value: "red" },
        { name: "background-image", value: "linear-gradient(red, blue)" },
      ])],
      transitionsStyle: style({ name: "background-color", value: "blue" }),
    });
    expect(otherAuthorLonghand).toEqual(available(true, false));
  });

  it("fails closed on partial CDP data and unresolved rollback substitutions", () => {
    expect(authorControlStyleFactsFromMatchedStyles({}).available).toBe(false);
    const partial = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [{ rule: { origin: "regular" } }],
    });
    expect(partial.available).toBe(false);
    const substitution = authorControlStyleFactsFromMatchedStyles({
      matchedCSSRules: [rule("regular", [{ name: "background-color", value: "var(--theme-bg)" }])],
    });
    expect(substitution.available).toBe(false);
    expect(substitution.reason).toContain("substitution");
  });
});
