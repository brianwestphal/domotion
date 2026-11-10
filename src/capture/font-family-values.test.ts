import { describe, expect, it } from "vitest";
import { substituteComputedFontVariables } from "./font-family-values.js";
const resolve = (value: string, data: Record<string, string> = {}) =>
  substituteComputedFontVariables(value, new Map(Object.entries(data)));
describe("computed font variable token authority", () => {
  it("preserves concrete and CSS-wide fallback tokens without computed family serialization", () => {
    expect(resolve("var(--face)", { "--face": "Times" })).toEqual({ kind: "value", value: "/**/Times/**/" });
    expect(resolve("var(--missing,initial)")).toEqual({ kind: "value", value: "/**/initial/**/" });
    expect(resolve("var(--missing)")).toEqual({ kind: "invalid" });
  });
  it("handles escaped names, nested fallbacks, comments and case-sensitive custom properties", () => {
    expect(resolve("v\\61r(--F\\61 ce, var(--fallback, 'Times'))", { "--Face": "Georgia" })).toEqual({
      kind: "value",
      value: "/**/Georgia/**/",
    });
    expect(resolve("var(/* name */ --face, var(--fallback,initial))", { "--fallback": "Times" })).toEqual({
      kind: "value",
      value: "/**/ /**/Times/**//**/",
    });
  });
  it("keeps strings literal and token boundaries apart", () => {
    expect(resolve('"var(--secret)"')).toEqual({ kind: "value", value: '"var(--secret)"' });
    expect(resolve("var(--n)px Times", { "--n": "12" })).toEqual({ kind: "value", value: "/**/12/**/px Times" });
    expect(resolve("var(--empty,initial)", { "--empty": "" })).toEqual({ kind: "value", value: "/**//**/" });
  });
  it.each(["env(face)", "attr(data-face)", "if(style(--a:b):Times)", "var(--x", "var(bad)"])(
    "retains unknown authority for %s",
    (value) => expect(resolve(value)).toMatchObject({ kind: "unknown" }),
  );
  it("bounds cycles, nesting and data size instead of calling them unset", () => {
    expect(resolve("var(--x)", { "--x": "var(--x)" })).toMatchObject({ kind: "unknown" });
    expect(resolve("x".repeat(65537))).toMatchObject({ kind: "unknown" });
  });
});
