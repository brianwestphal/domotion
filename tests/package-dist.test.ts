import { describe, expect, it } from "vitest";

import { packageDistProblems, packageExportsProblems } from "../scripts/check-package-dist.mjs";

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

describe("package exports map", () => {
  const exportsField = {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./dist/index.js": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./post-processing": { types: "./dist/post-processing/index.d.ts", default: "./dist/post-processing/index.js" },
    "./schemas/*": "./schemas/*",
    "./package.json": "./package.json",
  };
  const shipped = new Set([
    "./dist/index.d.ts",
    "./dist/index.js",
    "./dist/post-processing/index.d.ts",
    "./dist/post-processing/index.js",
    "./schemas",
    "./package.json",
  ]);
  const exists = (target: string): boolean => shipped.has(target);

  it("accepts a map whose every target, including wildcard directories, is shipped", () => {
    expect(packageExportsProblems(exportsField, exists)).toEqual([]);
  });

  it("requires the root, the documented dist/index.js alias, and package.json", () => {
    expect(packageExportsProblems({ "./post-processing": "./dist/post-processing/index.js" }, exists)).toEqual([
      'exports map is missing the "." entry',
      'exports map is missing the "./dist/index.js" entry',
      'exports map is missing the "./package.json" entry',
    ]);
  });

  it("rejects targets that are not shipped or not relative", () => {
    expect(
      packageExportsProblems(
        {
          ...exportsField,
          "./render": { types: "./dist/render/index.d.ts", default: "dist/render/index.js" },
          "./assets/*": "./assets/*",
        },
        exists,
      ),
    ).toEqual([
      'exports["./render"] target ./dist/render/index.d.ts does not exist',
      'exports["./render"] target dist/render/index.js must be a relative "./" path',
      'exports["./assets/*"] target ./assets/* does not exist',
    ]);
  });

  it("rejects a manifest without an exports map", () => {
    expect(packageExportsProblems(undefined, exists)).toEqual(["package.json has no exports map"]);
  });
});
