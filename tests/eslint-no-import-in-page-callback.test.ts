import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import rule from "../eslint-rules/no-import-in-page-callback.js";

const config = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    plugins: { domotion: { rules: { "no-import-in-page-callback": rule } } },
    rules: { "domotion/no-import-in-page-callback": "error" as const },
  },
];
const linter = new Linter();
const lint = (code: string) => linter.verify(code, config, "a.ts");
const names = (code: string): string[] => lint(code).map((m) => /'(\w+)'/.exec(m.message)?.[1] ?? m.message);

describe("domotion/no-import-in-page-callback", () => {
  it("flags an imported function called inside a page.evaluate callback (the shipped bug)", () => {
    expect(
      names(`import { isPaintedColor } from "./color.js";
await page.evaluate(() => isPaintedColor(getComputedStyle(document.body).backgroundColor));`),
    ).toEqual(["isPaintedColor"]);
  });

  it("flags default, namespace and aliased imports, and each method that runs in the page", () => {
    for (const method of ["evaluate", "evaluateHandle", "$eval", "$$eval", "waitForFunction", "addInitScript"]) {
      expect(names(`import def from "x";\npage.${method}(() => def());`)).toEqual(["def"]);
    }
    expect(names(`import * as ns from "x";\npage.evaluate(() => ns.a);`)).toEqual(["ns"]);
    expect(names(`import { a as b } from "x";\npage.evaluate(() => b);`)).toEqual(["b"]);
  });

  it("reaches through nested functions and the argument position after a selector", () => {
    expect(names(`import { h } from "x";\npage.evaluate(() => [1].map(() => h()));`)).toEqual(["h"]);
    expect(names(`import { h } from "x";\npage.$eval("a", (el) => h(el));`)).toEqual(["h"]);
    expect(names(`import { h } from "x";\npage.evaluate(function () { return h(); });`)).toEqual(["h"]);
  });

  it("allows type-only imports, values passed as arguments, and page-local bindings", () => {
    expect(
      lint(`import type { T } from "x";
import { type U } from "x";
import { k } from "y";
page.evaluate((arg: T | U) => arg, k);
page.evaluate(({ key }) => key, { key: k });
page.evaluate(() => { const local = 1; return local + document.title.length; });`),
    ).toEqual([]);
  });

  it("ignores calls that are not page methods, and callbacks outside them", () => {
    expect(
      lint(
        `import { h } from "x";\nsession.send("Runtime.evaluate", () => h());\nfoo(() => h());\nhandle.map(() => h());`,
      ),
    ).toEqual([]);
  });
});
