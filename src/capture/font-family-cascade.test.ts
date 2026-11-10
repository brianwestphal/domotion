import { describe, expect, it } from "vitest";
import {
  resolveMatchedFontFamilyType,
  fontLocaleMatchesCapturedLanguage,
  type FamilyMatched,
  type FamilyScope,
  type FamilyCascadeContext,
} from "./font-family-cascade.js";
const scope = (...values: string[]): FamilyScope => ({
  matchedCSSRules: values.map((value) => ({
    rule: { origin: "regular", originTreeScopeNodeId: 1, style: { cssProperties: [{ name: "font-family", value }] } },
  })),
});
const context: FamilyCascadeContext = {
  treeScopeId: 1,
  layers: {
    name: "implicit outer layer",
    order: 2,
    subLayers: [
      { name: "low", order: 0 },
      { name: "high", order: 1 },
    ],
  },
  resolve: async (value) => ({ kind: "value", value }),
};
const resolve = (matched: FamilyMatched, ctx: Partial<FamilyCascadeContext> = {}) =>
  resolveMatchedFontFamilyType(matched, { ...context, ...ctx });
describe("canonical initial-name family cascade (DM-ESH89H)", () => {
  it.each(["initial", "inherit", "unset", "revert"])(
    "keeps CSS-wide %s provenance distinct from computed Times",
    async (value) => {
      expect(await resolve({ ...scope(value), inherited: [scope("Times")] })).toEqual({
        type: value === "initial" ? "standard" : "concrete",
      });
    },
  );
  it("does not borrow a losing concrete ancestor through child initial", async () =>
    expect(await resolve({ ...scope("initial"), inherited: [scope("Times")] })).toEqual({ type: "standard" }));
  it("uses actual matched order and importance, not existence of a family declaration", async () => {
    expect(await resolve(scope("initial", "Times"))).toEqual({ type: "concrete" });
    expect(await resolve(scope("Times", "initial"))).toEqual({ type: "standard" });
    const m = scope("initial", "Times");
    m.matchedCSSRules![0].rule!.style!.cssProperties![0].important = true;
    expect(await resolve(m)).toEqual({ type: "standard" });
  });
  it("uses native layer order independently of matched specificity order", async () => {
    const m = scope("Times", "initial");
    m.matchedCSSRules![0].rule!.layers = [{ text: "high" }];
    m.matchedCSSRules![1].rule!.layers = [{ text: "low" }];
    expect(await resolve(m)).toEqual({ type: "concrete" });
    for (const row of m.matchedCSSRules!) row.rule!.style!.cssProperties![0].important = true;
    expect(await resolve(m)).toEqual({ type: "standard" });
  });
  it("removes importance from rollback layer comparison as Blink does", async () => {
    const m = scope("Times", "revert-layer");
    m.matchedCSSRules![0].rule!.layers = [{ text: "low" }];
    m.matchedCSSRules![1].rule!.layers = [{ text: "high" }];
    m.matchedCSSRules![1].rule!.style!.cssProperties![0].important = true;
    expect(await resolve(m)).toEqual({ type: "concrete" });
    m.matchedCSSRules![0].rule!.layers = [];
    expect(await resolve(m)).toEqual({ type: "standard" });
  });
  it("keeps inline origin priority and author revert from falling into another author declaration", async () => {
    expect(
      await resolve({ ...scope("Times"), inlineStyle: { cssProperties: [{ name: "font-family", value: "revert" }] } }),
    ).toEqual({ type: "standard" });
    expect(
      await resolve({ ...scope("Times"), inlineStyle: { cssProperties: [{ name: "font-family", value: "initial" }] } }),
    ).toEqual({ type: "standard" });
  });
  it("inherits known-invalid substituted values but refuses unknown authority", async () => {
    expect(
      await resolve(
        { ...scope("var(--missing)"), inherited: [scope("Times")] },
        { resolve: async (value) => (value.startsWith("var") ? { kind: "invalid" } : { kind: "value", value }) },
      ),
    ).toEqual({ type: "concrete" });
    expect(
      await resolve(scope("var(--unknown)"), {
        resolve: async () => ({ kind: "unknown", reason: "unavailable tokens" }),
      }),
    ).toEqual({ reason: "unavailable tokens" });
  });
  it("pairs pending family with canonical font shorthand, never losing raw text", async () => {
    const m = scope("");
    m.matchedCSSRules![0].rule!.style!.shorthandEntries = [{ name: "font", value: "var(--font)" }];
    expect(
      await resolve(m, {
        resolve: async (value, shorthand) => {
          expect(value).toBe("var(--font)");
          expect(shorthand).toBe(true);
          return { kind: "value", value: "Times" };
        },
      }),
    ).toEqual({ type: "concrete" });
    m.matchedCSSRules![0].rule!.style!.cssProperties![0] = {
      name: "font-family",
      value: " !important",
      important: true,
    };
    m.matchedCSSRules![0].rule!.style!.shorthandEntries![0].value = "var(--font) !important";
    expect(
      await resolve(m, {
        resolve: async (value, shorthand) => {
          expect(value).toBe("var(--font)");
          expect(shorthand).toBe(true);
          return { kind: "value", value: "Times" };
        },
      }),
    ).toEqual({ type: "concrete" });
    delete m.matchedCSSRules![0].rule!.style!.shorthandEntries;
    expect(await resolve(m)).toEqual({ reason: "pending family has no canonical shorthand" });
  });
  it("uses canonical entries rather than raw overwritten source declarations", async () => {
    const m = scope("Times");
    m.matchedCSSRules![0].rule!.style!.cssProperties!.unshift(
      Object.assign({ name: "font-family", value: "initial" }, { range: {}, text: "font-family:initial" }),
    );
    expect(await resolve(m)).toEqual({ type: "concrete" });
    m.matchedCSSRules![0].rule!.style!.cssProperties!.pop();
    expect(await resolve(m)).toEqual({ reason: "missing canonical family longhand" });
  });
  it("preserves quoted reserved names as concrete and declines generic ambiguity", async () => {
    expect(await resolve(scope('"initial"'))).toEqual({ type: "concrete" });
    expect(await resolve(scope("serif"))).toMatchObject({ reason: expect.any(String) });
  });
  it("does not infer original family type from an interpolated Times value", async () => {
    expect(
      await resolve({
        ...scope("initial"),
        animationStyles: [{ style: { cssProperties: [{ name: "font-family", value: "Times" }] } }],
      }),
    ).toEqual({ reason: "interpolated family lost original type" });
    const m = {
      ...scope("initial"),
      animationStyles: [{ style: { cssProperties: [{ name: "font-family", value: "Times" }] } }],
    };
    m.matchedCSSRules![0].rule!.style!.cssProperties![0].important = true;
    expect(await resolve(m)).toEqual({ type: "standard" });
  });
  it("refuses incomplete, composed or nested/anonymous layer authority", async () => {
    expect(await resolve({})).toMatchObject({ reason: expect.any(String) });
    const m = scope("Times");
    m.matchedCSSRules![0].rule!.originTreeScopeNodeId = 99;
    expect(await resolve(m)).toEqual({ reason: "unproved font tree-scope order" });
    expect(
      await resolve(scope("Times"), { layers: { name: "outer", order: 1, subLayers: [{ name: "", order: 0 }] } }),
    ).toMatchObject({ reason: expect.any(String) });
    expect(
      await resolve(scope("Times"), {
        layers: { name: "outer", order: 2, subLayers: [{ name: "x", order: 1, subLayers: [{ name: "y", order: 0 }] }] },
      }),
    ).toMatchObject({ reason: expect.any(String) });
  });
});

it("does not confuse a computed font-locale reset with DOM language", () => {
  expect(fontLocaleMatchesCapturedLanguage('"ja"', "ja")).toBe(true);
  expect(fontLocaleMatchesCapturedLanguage('"JA-jp"', "ja-JP")).toBe(true);
  expect(fontLocaleMatchesCapturedLanguage("auto", "")).toBe(true);
  expect(fontLocaleMatchesCapturedLanguage("auto", "ja")).toBe(false);
  expect(fontLocaleMatchesCapturedLanguage(undefined, "ja")).toBe(false);
  expect(fontLocaleMatchesCapturedLanguage("ja", "ja")).toBe(false);
});

it("does not treat an unproved all substitution as a literal family", async () => {
  const m: FamilyMatched = {
    matchedCSSRules: [],
    inlineStyle: { cssProperties: [{ name: "all", value: "var(--face)" }] },
  };
  expect(await resolve(m, { resolve: async () => ({ kind: "value", value: "Times" }) })).toEqual({
    reason: "all substitution has no proved CSS-wide result",
  });
});

it("does not infer user-vs-author origin from the inspector injected label", async () => {
  const m = scope("initial");
  m.matchedCSSRules![0].rule!.origin = "injected";
  expect(await resolve(m)).toEqual({ reason: "unsupported stylesheet origin" });
  m.matchedCSSRules![0].rule!.style!.cssProperties = [{ name: "color", value: "red" }];
  expect(await resolve(m)).toEqual({ type: "standard" });
});
it("keeps unproved starting/scoped family rules from overriding a known ancestor", async () => {
  const m = scope("initial");
  m.matchedCSSRules![0].rule!.startingStyles = [{}];
  expect(await resolve({ ...m, inherited: [scope("Times")] })).toEqual({
    reason: "unproved scoped or starting font cascade",
  });
});
it("resolves an inherited substitution in its parent context", async () => {
  expect(
    await resolve(
      { ...scope(), inherited: [scope("var(--face)")] },
      {
        resolve: async (value, _shorthand, index) => {
          expect(value).toBe("var(--face)");
          expect(index).toBe(1);
          return { kind: "value", value: "Times" };
        },
      },
    ),
  ).toEqual({ type: "concrete" });
});
