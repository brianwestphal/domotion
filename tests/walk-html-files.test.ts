import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkHtmlFiles } from "./walk-html-files.js";

// DM-1230: the html suite walks the cloned `external/html-test` root, which on
// CI also contains the `unicode/` per-block fixtures the unicode suite targets
// directly — they must NOT be double-covered by the html walk.
describe("walkHtmlFiles", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "walk-html-"));
    // Top-level html fixtures.
    writeFileSync(join(root, "01-foo.html"), "x");
    writeFileSync(join(root, "index.html"), "x"); // generated overview — excluded
    writeFileSync(join(root, "_scratch.html"), "x"); // underscore — excluded
    // A normal nested subdir (e.g. `niche/`) — INCLUDED.
    mkdirSync(join(root, "niche"));
    writeFileSync(join(root, "niche", "bar.html"), "x");
    // The unicode/ subdir — EXCLUDED at the root.
    mkdirSync(join(root, "unicode"));
    writeFileSync(join(root, "unicode", "0000-007F-basic-latin.html"), "x");
    writeFileSync(join(root, "unicode", "3000-303F-cjk.html"), "x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("excludes a top-level unicode/ subdir, index.html, and underscore files", () => {
    expect(walkHtmlFiles(root)).toEqual(["01-foo.html", "niche/bar.html"]);
  });

  it("still walks unicode fixtures when unicode/ IS the root (the unicode suite)", () => {
    expect(walkHtmlFiles(join(root, "unicode"))).toEqual([
      "0000-007F-basic-latin.html",
      "3000-303F-cjk.html",
    ]);
  });

  it("does NOT exclude a nested (non-root) unicode/ dir", () => {
    // A `unicode/` nested under another dir is only reachable below the root, so
    // the root-scoped skip must not touch it.
    mkdirSync(join(root, "niche", "unicode"));
    writeFileSync(join(root, "niche", "unicode", "deep.html"), "x");
    expect(walkHtmlFiles(root)).toContain("niche/unicode/deep.html");
  });
});
