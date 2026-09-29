import { describe, expect, it } from "vitest";
import { listBuiltinTemplates } from "../registry.js";
import { templateParamsJsonSchema } from "../json-schema.js";
import { validateTemplateParams } from "../render.js";
import { CARD_FONT_STACK, THEMES, blank, cssValue, isPlainCssValue } from "./shared.js";

describe("isPlainCssValue", () => {
  it("accepts colors, gradients, url() and font stacks", () => {
    for (const v of [
      "#fff",
      "rgba(0, 0, 0, 0.5)",
      "linear-gradient(135deg, #111 0%, #222 100%)",
      'url("data:image/svg+xml;base64,AAAA")',
      CARD_FONT_STACK,
      "transparent",
    ]) {
      expect(isPlainCssValue(v)).toBe(true);
    }
  });

  it("rejects anything that could close the style block or open a rule", () => {
    for (const v of ["red;} body{display:none", "</style><script>alert(1)</script>", "red\nblue", "a{b}", "x\u0000y"]) {
      expect(isPlainCssValue(v)).toBe(false);
    }
  });
});

describe("cssValue schema", () => {
  it("passes an accepted value through unchanged and composes with default/optional", () => {
    expect(cssValue().default("#000").parse(undefined)).toBe("#000");
    expect(cssValue().optional().parse(undefined)).toBeUndefined();
    expect(cssValue().parse("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(cssValue().safeParse("red;}</style>").success).toBe(false);
  });
});

describe("shared helpers", () => {
  it("blank normalizes empty to undefined and keeps real values", () => {
    expect(blank(undefined)).toBeUndefined();
    expect(blank("")).toBeUndefined();
    expect(blank("x")).toBe("x");
    expect(THEMES).toEqual(["dark", "light"]);
  });
});

describe("every built-in template rejects style-breaking values in its CSS params", () => {
  const hostile = "red;} body{display:none} </style><script>1</script>";
  const templates = listBuiltinTemplates();
  const cssKeys = /^(color|textColor|accent|background|fontFamily|[a-zA-Z]*Color|[a-zA-Z]*Bg|[a-zA-Z]*Background)$/;

  it("covers a meaningful number of params", () => {
    let count = 0;
    for (const t of templates) {
      const props = (templateParamsJsonSchema(t) as { properties?: Record<string, unknown> }).properties ?? {};
      count += Object.keys(props).filter((k) => cssKeys.test(k)).length;
    }
    expect(count).toBeGreaterThan(30);
  });

  for (const t of templates) {
    const props = (templateParamsJsonSchema(t) as { properties?: Record<string, { type?: string }> }).properties ?? {};
    const keys = Object.keys(props).filter((k) => cssKeys.test(k) && props[k]?.type === "string");
    for (const key of keys) {
      it(`${t.name}.${key}`, () => {
        // Minimal valid input per template is unknown, so assert on the field's own schema path.
        const attempt = (): unknown => validateTemplateParams(t, { title: "x", text: "x", label: "x", [key]: hostile });
        expect(attempt).toThrow();
        try {
          attempt();
        } catch (error) {
          expect((error as Error).message).toContain(key);
        }
      });
    }
  }
});
