import { describe, expect, it } from "vitest";
import { packIgnoredArtifactProblems, repoPathForPackedPath } from "../scripts/check-pack-contents.mjs";

describe("repoPathForPackedPath", () => {
  it("maps root and bundled-workspace tarball paths to repository paths", () => {
    expect(repoPathForPackedPath("dist/index.js")).toBe("dist/index.js");
    expect(repoPathForPackedPath("node_modules/@domotion/text-engine/tools/icu-helper/icudtl.dat")).toBe(
      "packages/text-engine/tools/icu-helper/icudtl.dat",
    );
  });

  it("ignores third-party bundled dependencies, which this repository's .gitignore does not govern", () => {
    expect(repoPathForPackedPath("node_modules/fontkit/dist/main.cjs")).toBeNull();
  });
});

describe("packIgnoredArtifactProblems", () => {
  const ignored = new Set([
    "dist/index.js",
    "packages/text-engine/dist/index.js",
    "packages/text-engine/tools/icu-helper/icudtl.dat",
    "packages/text-engine/tools/icu-helper/domotion-icu",
  ]);
  const isIgnored = (path: string): boolean => ignored.has(path);

  it("allows gitignored build output under the dist directories", () => {
    expect(
      packIgnoredArtifactProblems(["dist/index.js", "node_modules/@domotion/text-engine/dist/index.js"], isIgnored),
    ).toEqual([]);
  });

  it("reports gitignored host-local helper artifacts in the bundled workspace", () => {
    expect(
      packIgnoredArtifactProblems(
        [
          "node_modules/@domotion/text-engine/tools/icu-helper/README.md",
          "node_modules/@domotion/text-engine/tools/icu-helper/icudtl.dat",
          "node_modules/@domotion/text-engine/tools/icu-helper/domotion-icu",
        ],
        isIgnored,
      ),
    ).toEqual([
      "tarball ships gitignored host-local file: node_modules/@domotion/text-engine/tools/icu-helper/icudtl.dat",
      "tarball ships gitignored host-local file: node_modules/@domotion/text-engine/tools/icu-helper/domotion-icu",
    ]);
  });

  it("does not exempt a path that merely resembles a dist directory", () => {
    const fake = "packages/text-engine/tools/dist/helper";
    expect(
      packIgnoredArtifactProblems(["node_modules/@domotion/text-engine/tools/dist/helper"], (path) => path === fake),
    ).toHaveLength(1);
  });
});
