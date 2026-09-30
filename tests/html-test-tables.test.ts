import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTED_DIFFS, FIXTURE_HEIGHT_OVERRIDES, SKIP_TESTS, captureHeightFor } from "./html-test/tables.js";
import { walkHtmlFiles } from "./walk-html-files.js";

const htmlRoot = resolve("external/html-test");
const unicodeRoot = resolve("../html-test/unicode");

describe("html-test fixture tables", () => {
  it("uses the documented default and height overrides", () => {
    expect(captureHeightFor("absent-fixture")).toBe(768);
    for (const [name, height] of Object.entries(FIXTURE_HEIGHT_OVERRIDES)) {
      expect(captureHeightFor(name)).toBe(height);
      expect(height).toBeGreaterThanOrEqual(768);
    }
  });

  it("contains no stale fixture names in installed checkouts", () => {
    if (!existsSync(htmlRoot) && !existsSync(unicodeRoot)) return;
    const namesFor = (root: string) =>
      new Set(
        existsSync(root) ? walkHtmlFiles(root).map((file) => file.replace(/\.html$/, "").replace(/\//g, "-")) : [],
      );
    const htmlNames = namesFor(htmlRoot);
    const unicodeNames = namesFor(unicodeRoot);
    for (const table of [FIXTURE_HEIGHT_OVERRIDES, SKIP_TESTS, ACCEPTED_DIFFS]) {
      const missing = Object.keys(table).filter((name) => {
        const unicode = /^[0-9A-F]{4,6}-[0-9A-F]{4,6}-/.test(name);
        if (unicode) return existsSync(unicodeRoot) && !unicodeNames.has(name);
        return existsSync(htmlRoot) && !htmlNames.has(name);
      });
      expect(missing).toEqual([]);
    }
  });
});
