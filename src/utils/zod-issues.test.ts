import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatIssuePath, formatIssues } from "./zod-issues.js";

describe("formatIssuePath", () => {
  it("joins keys with dots and writes indexes as [n], without a leading dot", () => {
    expect(formatIssuePath(["scenes", 0, "tracks", 2, "at"])).toBe("scenes[0].tracks[2].at");
    expect(formatIssuePath([0, "id"])).toBe("[0].id");
    expect(formatIssuePath([])).toBe("");
  });

  it("appends to a base, which a root-level path renders as", () => {
    expect(formatIssuePath(["scenes", 1, "id"], "$")).toBe("$.scenes[1].id");
    expect(formatIssuePath([], "$")).toBe("$");
    expect(formatIssuePath([3, "events"], "$.scene.tracks")).toBe("$.scene.tracks[3].events");
  });

  it("stringifies symbol keys", () => {
    expect(formatIssuePath([Symbol("k")])).toBe("Symbol(k)");
  });
});

describe("formatIssues", () => {
  it("renders every issue as path: message joined by '; ', and a root issue as its message alone", () => {
    expect(
      formatIssues([
        { path: ["a", 0], message: "bad" },
        { path: [], message: "Expected object" },
      ]),
    ).toBe("a[0]: bad; Expected object");
  });

  it("keeps the base on a root-level issue in the based style", () => {
    expect(formatIssues([{ path: [], message: "Expected object" }], "$")).toBe("$: Expected object");
  });

  it("reads a real ZodError's issues", () => {
    const parsed = z.object({ items: z.array(z.number()) }).safeParse({ items: [1, "two"] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatIssues(parsed.error.issues)).toMatch(/^items\[1\]: /);
    expect(formatIssues(parsed.error.issues, "$")).toMatch(/^\$\.items\[1\]: /);
  });
});
