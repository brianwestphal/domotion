import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { documentationCodePathErrors } from "../scripts/documentation-code-paths.mjs";

const ROOT = resolve("/repo");
const existing = new Set([
  resolve(ROOT, "src/render/real.ts"),
  resolve(ROOT, "src/scroll"),
]);
const pathExists = (path: string): boolean => existing.has(path);

describe("documentation code ownership (DM-2631)", () => {
  it("rejects every missing live path even when another owner exists", () => {
    expect(documentationCodePathErrors("handbook/text.md", {
      status: "current",
      code: ["src/render/real.ts", "src/render/removed.ts", "tests/removed.test.ts"],
    }, ROOT, pathExists)).toEqual([
      "handbook/text.md: code path does not exist: src/render/removed.ts",
      "handbook/text.md: code path does not exist: tests/removed.test.ts",
    ]);
  });

  it("accepts existing files and owning directories on current/partial records", () => {
    for (const status of ["current", "partial"]) {
      expect(documentationCodePathErrors("live.md", {
        status,
        code: ["src/render/real.ts", "src/scroll/"],
      }, ROOT, pathExists)).toEqual([]);
    }
  });

  it("leaves historical paths intact but rejects invalid live declarations", () => {
    expect(documentationCodePathErrors("archive.md", {
      status: "superseded",
      code: ["src/removed.ts"],
    }, ROOT, pathExists)).toEqual([]);
    expect(documentationCodePathErrors("live.md", {
      status: "current",
      code: ["", "../outside.ts"],
    }, ROOT, pathExists)).toEqual([
      "live.md: code path must be a non-empty repository-relative string",
      "live.md: code path escapes the repository: ../outside.ts",
    ]);
  });
});
