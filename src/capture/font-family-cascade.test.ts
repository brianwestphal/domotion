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
  it("refuses incomplete identity and a rule in an anonymous layer", async () => {
    expect(await resolve({})).toMatchObject({ reason: expect.any(String) });
    const m = scope("Times");
    m.matchedCSSRules![0].rule!.originTreeScopeNodeId = 99;
    expect(await resolve(m)).toEqual({ reason: "unproved font tree-scope order" });
    const anonymous = {
      name: "outer",
      order: 2,
      subLayers: [
        { name: "", order: 0 },
        { name: "", order: 1 },
      ],
    };
    // An unused anonymous layer does not affect unlayered rules…
    expect(await resolve(scope("Times"), { layers: anonymous })).toEqual({ type: "concrete" });
    // …but a rule inside one cannot be placed.
    const inAnonymous = scope("Times");
    inAnonymous.matchedCSSRules![0].rule!.layers = [{ text: "" }];
    expect(await resolve(inAnonymous, { layers: anonymous })).toEqual({ reason: "unproved font layer identity" });
    const missing = scope("Times");
    missing.matchedCSSRules![0].rule!.layers = [{ text: "absent" }];
    expect(await resolve(missing)).toEqual({ reason: "unproved font layer identity" });
  });
  it("orders nested and dotted layers by the native post-order numbering", async () => {
    // @layer a { @layer b {…} } @layer a.c {…} @layer a {…}: b=0, c=1, a=2, outer=3
    // (ComputeLayerOrder, cascade_layer_map.cc:40-47).
    const layers = {
      name: "implicit outer layer",
      order: 3,
      subLayers: [
        {
          name: "a",
          order: 2,
          subLayers: [
            { name: "b", order: 0 },
            { name: "c", order: 1 },
          ],
        },
      ],
    };
    const m = scope("initial", "Times", "initial");
    m.matchedCSSRules![0].rule!.layers = [{ text: "a" }];
    m.matchedCSSRules![1].rule!.layers = [{ text: "a.c" }];
    m.matchedCSSRules![2].rule!.layers = [{ text: "a" }, { text: "b" }];
    // a (order 2) beats a.c (1) and a.b (0) for normal declarations.
    expect(await resolve(m, { layers })).toEqual({ type: "standard" });
    // With a.b's value concrete and a's removed, a.c still beats a.b.
    const n = scope("Times", "initial");
    n.matchedCSSRules![0].rule!.layers = [{ text: "a" }, { text: "b" }];
    n.matchedCSSRules![1].rule!.layers = [{ text: "a.c" }];
    expect(await resolve(n, { layers })).toEqual({ type: "standard" });
    for (const row of n.matchedCSSRules!) row.rule!.style!.cssProperties![0].important = true;
    expect(await resolve(n, { layers })).toEqual({ type: "concrete" });
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

describe("tree-context order across shadow scopes", () => {
  // Shapes from Chromium 147: a slotted span and a shadow host, each matched by
  // a rule from the shadow root (scope 11) and one from the document (scope 5).
  const rule = (scopeId: number, value: string, important = false, layers?: Array<{ text: string }>) => ({
    rule: {
      origin: "regular",
      originTreeScopeNodeId: scopeId,
      style: { cssProperties: [{ name: "font-family", value, important }] },
      ...(layers != null ? { layers } : {}),
    },
  });
  const layers = { name: "implicit outer layer", order: 0 };
  // ::slotted and :host rules come from the shadow root, which precedes the
  // element's own document scope in tree order.
  const treeContexts = [{ treeScopes: [11, 5], elementScope: 5, layers }];
  it("lets the later (outer) scope win for normal declarations", async () => {
    expect(await resolve({ matchedCSSRules: [rule(11, "initial"), rule(5, "Courier")] }, { treeContexts })).toEqual({
      type: "concrete",
    });
    expect(await resolve({ matchedCSSRules: [rule(11, "Courier"), rule(5, "initial")] }, { treeContexts })).toEqual({
      type: "standard",
    });
  });
  it("lets the earlier (inner) scope win for important declarations", async () => {
    expect(
      await resolve({ matchedCSSRules: [rule(11, "initial", true), rule(5, "Arial", true)] }, { treeContexts }),
    ).toEqual({ type: "standard" });
    // Importance still outranks tree order.
    expect(await resolve({ matchedCSSRules: [rule(11, "initial"), rule(5, "Arial", true)] }, { treeContexts })).toEqual(
      { type: "concrete" },
    );
  });
  it("puts the style attribute in the element scope's group", async () => {
    const inlineStyle = { cssProperties: [{ name: "font-family", value: "initial" }] };
    // The inline style shares the document rule's tree order and wins as inline.
    expect(
      await resolve({ matchedCSSRules: [rule(11, "Courier"), rule(5, "Courier")], inlineStyle }, { treeContexts }),
    ).toEqual({ type: "standard" });
    // An element inside the shadow root: a document ::part rule is a later
    // group than the element scope, so it beats the inline style.
    expect(
      await resolve(
        { matchedCSSRules: [rule(5, "Courier")], inlineStyle },
        { treeContexts: [{ treeScopes: [11, 5], elementScope: 11, layers }] },
      ),
    ).toEqual({ type: "concrete" });
  });
  it("negative control: a reordered rule list is refused, not reinterpreted", async () => {
    expect(await resolve({ matchedCSSRules: [rule(5, "Courier"), rule(11, "initial")] }, { treeContexts })).toEqual({
      reason: "matched font rule order contradicts tree order",
    });
  });
  it("refuses a scope outside the element's tree contexts and a layered rule from another scope", async () => {
    expect(await resolve({ matchedCSSRules: [rule(12, "Courier")] }, { treeContexts })).toEqual({
      reason: "unproved font tree-scope order",
    });
    const layered = { name: "implicit outer layer", order: 1, subLayers: [{ name: "a", order: 0 }] };
    expect(
      await resolve(
        { matchedCSSRules: [rule(11, "Courier", false, [{ text: "a" }])] },
        { treeContexts: [{ treeScopes: [11, 5], elementScope: 5, layers: layered }] },
      ),
    ).toEqual({ reason: "unproved font layer identity" });
  });
});
