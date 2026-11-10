import { describe, expect, it } from "vitest";
import { matchedFamilyIsUnambiguouslyAuthored, type MatchedFamilyDeclarations } from "./font-family-declarations.js";

function rules(...values: string[]): MatchedFamilyDeclarations {
  return {
    matchedCSSRules: values.map((value) => ({
      rule: {
        origin: "regular",
        style: { cssProperties: [{ name: "font-family", value }] },
      },
    })),
  };
}

describe("opaque-sheet literal family declaration evidence", () => {
  it.each(["Times", '"Times New Roman"', '"initial"', '"serif"', "Georgia, Times"])("admits concrete %s", (value) => {
    expect(matchedFamilyIsUnambiguouslyAuthored(rules(value))).toBe(true);
  });
  it("admits overridden concrete declarations without choosing a winner", () => {
    expect(matchedFamilyIsUnambiguouslyAuthored(rules("Georgia", "Times"))).toBe(true);
  });
  it.each([
    "initial",
    "inherit",
    "unset",
    "revert",
    "revert-layer",
    "revert-rule",
    "var(--face)",
    "env(face)",
    "serif",
    "SeRiF",
    "-WEBKIT-STANDARD",
    "\\69 nitial",
    "v\\61 r(--face)",
    "",
  ])("does not invent authority for %s", (value) => {
    expect(matchedFamilyIsUnambiguouslyAuthored(rules(value))).toBe(false);
    expect(matchedFamilyIsUnambiguouslyAuthored(rules("Times", value))).toBe(false);
  });
  it("inherits a concrete ancestor only through scopes without family declarations", () => {
    expect(matchedFamilyIsUnambiguouslyAuthored({ ...rules(), inherited: [rules(), rules("Times")] })).toBe(true);
    expect(matchedFamilyIsUnambiguouslyAuthored({ ...rules("initial"), inherited: [rules("Times")] })).toBe(false);
    expect(matchedFamilyIsUnambiguouslyAuthored({ ...rules(), inherited: [rules("unset"), rules("Times")] })).toBe(
      false,
    );
    expect(matchedFamilyIsUnambiguouslyAuthored({ ...rules("Times"), inherited: [rules("var(--face)")] })).toBe(true);
  });
  it("requires an author declaration rather than a UA concrete family", () => {
    const matched = rules("Times");
    matched.matchedCSSRules![0].rule!.origin = "user-agent";
    expect(matchedFamilyIsUnambiguouslyAuthored(matched)).toBe(false);
  });
  it("requires complete font shorthand expansion and rejects all resets", () => {
    const matched = (name: string, value: string, longhandProperties?: Array<{ name: string; value: string }>) => ({
      inlineStyle: { cssProperties: [{ name, value, longhandProperties }] },
      matchedCSSRules: [],
    });
    expect(
      matchedFamilyIsUnambiguouslyAuthored(matched("font", "32px Times", [{ name: "font-family", value: "Times" }])),
    ).toBe(true);
    expect(matchedFamilyIsUnambiguouslyAuthored(matched("font", "var(--font)"))).toBe(false);
    expect(matchedFamilyIsUnambiguouslyAuthored({ ...rules("Times"), ...matched("all", "initial") })).toBe(false);
  });
  it("ignores disabled and invalid declarations, but respects animated resets", () => {
    const matched = rules("Times");
    matched.matchedCSSRules![0].rule!.style!.cssProperties!.push(
      { name: "font-family", value: "initial", disabled: true },
      { name: "font-family", value: "garbage(", parsedOk: false },
    );
    expect(matchedFamilyIsUnambiguouslyAuthored(matched)).toBe(true);
    matched.animationStyles = [{ style: { cssProperties: [{ name: "font-family", value: "initial" }] } }];
    expect(matchedFamilyIsUnambiguouslyAuthored(matched)).toBe(false);
    matched.animationStyles = [{ style: { cssProperties: [{ name: "font-family", value: "Times" }] } }];
    expect(matchedFamilyIsUnambiguouslyAuthored(matched)).toBe(false);
  });
  it("does not skip an incomplete scope to claim its authored ancestor", () => {
    expect(matchedFamilyIsUnambiguouslyAuthored({ inherited: [rules("Times")] })).toBe(false);
    expect(
      matchedFamilyIsUnambiguouslyAuthored({
        matchedCSSRules: [{ rule: { origin: "regular" } }],
        inherited: [rules("Times")],
      }),
    ).toBe(false);
  });
  it("uses canonical values rather than losing source declarations and strips their protocol priority", () => {
    const matched = rules("Times !important");
    matched.matchedCSSRules![0].rule!.style!.cssProperties![0].important = true;
    expect(matchedFamilyIsUnambiguouslyAuthored(matched)).toBe(true);
    const initial = rules("initial !important");
    initial.matchedCSSRules![0].rule!.style!.cssProperties![0].important = true;
    expect(matchedFamilyIsUnambiguouslyAuthored(initial)).toBe(false);
    matched.matchedCSSRules![0].rule!.style!.cssProperties!.unshift(
      Object.assign({ name: "font-family", value: "initial" }, { text: "font-family:initial", range: {} }),
    );
    expect(matchedFamilyIsUnambiguouslyAuthored(matched)).toBe(true);
    const partial = {
      matchedCSSRules: [
        {
          rule: {
            origin: "regular",
            style: { cssProperties: [{ name: "font-\\66 amily", value: "initial", text: "font-\\66 amily:initial" }] },
          },
        },
      ],
      inherited: [rules("Times")],
    };
    expect(matchedFamilyIsUnambiguouslyAuthored(partial)).toBe(false);
  });
});
