import { describe, expect, it } from "vitest";
import { declaredTestTitles, transitionEvidenceProblems } from "../tools/feature-transition-evidence.js";

describe("feature transition evidence", () => {
  it("extracts only literal it/test declarations, including modifiers and each", () => {
    const source = `
      // it("comment is not evidence", () => {});
      const fixture = 'test("fixture is not evidence", () => {})';
      describe("suite", () => {
        it("direct assertion", () => {});
        test.skip('skipped assertion', () => {});
        it.each([[1]])(\`matrix assertion\`, () => {});
      });
    `;
    expect([...declaredTestTitles(source)].sort()).toEqual([
      "direct assertion",
      "matrix assertion",
      "skipped assertion",
    ]);
  });

  it("rejects missing, unlisted, stale, duplicate, and non-transition evidence", () => {
    const features = [
      { id: "missing", tests: ["a.test.ts"], transition: "a → b" },
      {
        id: "unlisted", tests: ["a.test.ts"], transition: "a → b",
        transitionEvidence: [{ test: "b.test.ts", title: "asserts the transition" }],
      },
      {
        id: "stale", tests: ["a.test.ts"], transition: "a → b",
        transitionEvidence: [{ test: "a.test.ts", title: "only mentioned in a comment" }],
      },
      {
        id: "duplicate", tests: ["a.test.ts"], transition: "a → b",
        transitionEvidence: [
          { test: "a.test.ts", title: "asserts the transition" },
          { test: "a.test.ts", title: "asserts the transition" },
        ],
      },
      {
        id: "not-transition", tests: ["a.test.ts"],
        transitionEvidence: [{ test: "a.test.ts", title: "asserts the transition" }],
      },
    ];
    const problems = transitionEvidenceProblems(features, (path) => path === "a.test.ts"
      ? '// only mentioned in a comment\nit("asserts the transition", () => {});'
      : undefined);
    expect(problems).toEqual([
      "missing has a transition but no transitionEvidence",
      "unlisted transition evidence is not listed in tests: b.test.ts",
      'stale transition evidence title is not declared by a.test.ts: "only mentioned in a comment"',
      'duplicate repeats transition evidence a.test.ts → "asserts the transition"',
      "not-transition has transitionEvidence but no transition",
    ]);
  });

  it("accepts an exact title from a test file already listed by the feature", () => {
    expect(transitionEvidenceProblems([{
      id: "valid",
      tests: ["transition.test.ts"],
      transition: "off → on",
      transitionEvidence: [{ test: "transition.test.ts", title: "moves from off to on" }],
    }], () => 'it("moves from off to on", () => {});')).toEqual([]);
  });
});
