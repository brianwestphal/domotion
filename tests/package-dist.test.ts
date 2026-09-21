import { describe, expect, it } from "vitest";

import { packageDistProblems } from "../scripts/check-package-dist.mjs";

describe("published dist manifest", () => {
  const sources = [
    "index.ts",
    "capture/current.ts",
    "capture/current.test.ts",
    "capture/browser.e2e.test.ts",
    "test-support/fixture.ts",
    "globals.d.ts",
  ];
  const current = ["index.js", "index.d.ts", "capture/current.js", "capture/current.d.ts"];

  it("accepts exactly the publishable source modules and declarations", () => {
    expect(packageDistProblems(sources, current)).toEqual([]);
  });

  it("rejects compiled tests, test support, and deleted-module leftovers", () => {
    expect(
      packageDistProblems(sources, [
        ...current,
        "capture/current.test.js",
        "capture/browser.e2e.test.d.ts",
        "test-support/fixture.js",
        "capture/paged-stale.js",
      ]),
    ).toEqual([
      "unexpected dist artifact: capture/browser.e2e.test.d.ts",
      "unexpected dist artifact: capture/current.test.js",
      "unexpected dist artifact: capture/paged-stale.js",
      "unexpected dist artifact: test-support/fixture.js",
    ]);
  });

  it("rejects incomplete compiled module pairs", () => {
    expect(packageDistProblems(sources, ["index.js", "capture/current.d.ts"])).toEqual([
      "missing dist artifact: capture/current.js",
      "missing dist artifact: index.d.ts",
    ]);
  });
});
