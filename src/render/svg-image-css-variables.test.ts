import { describe, expect, it } from "vitest";
import { resolveImageCssVariables } from "./svg-image-css-variables.js";

const expand = (value: string, declarations: Record<string, string>): string | null =>
  resolveImageCssVariables(value, (name) => declarations[name] ?? null)?.trim() ?? null;

describe("isolated image custom properties (DM-53WRGR)", () => {
  it("resolves nested values, missing fallbacks and case-sensitive names", () => {
    expect(expand("var(--Size)", { "--Size": "24px", "--size": "10px" })).toBe("24px");
    expect(expand("var(--outer)", { "--outer": "var(--inner)", "--inner": "20px" })).toBe("20px");
    expect(expand("var(--missing, min(20px, 2em))", {})).toBe("min(20px, 2em)");
    expect(expand('"var(--size)" /* var(--size) */', { "--size": "20px" })).toBe('"var(--size)" /* var(--size) */');
  });

  it("invalidates cycles including dependencies in unused fallbacks", () => {
    expect(expand("var(--self, 18px)", { "--self": "var(--self, 12px)" })).toBe("18px");
    expect(expand("var(--a)", { "--a": "var(--b)", "--b": "var(--a)" })).toBeNull();
    expect(expand("var(--a, 18px)", { "--a": "var(--b, var(--a))", "--b": "20px" })).toBe("18px");
    expect(expand("var(--missing)", {})).toBeNull();
    expect(expand("var(--bad)", { "--bad": "inherit" })).toBeNull();
    expect(expand("var(--b, 20px)", { "--b": "var(--a)", "--a": "revert-layer" })).toBeNull();
    expect(resolveImageCssVariables("var(--unknown,20px)", () => undefined)).toBeNull();
  });

  it("preserves substitution token boundaries and bounds expansion", () => {
    expect(expand("var(--n)px", { "--n": "12" })).toBe("12 px");
    expect(expand("var(--a)", { "--a": "x".repeat(65537) })).toBeNull();
    expect(expand("var(--a", { "--a": "20px" })).toBeNull();
  });
});
