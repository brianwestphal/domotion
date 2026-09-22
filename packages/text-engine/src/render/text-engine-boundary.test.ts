import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("text-engine package boundary", () => {
  it("does not import source outside its workspace", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const sourceRoot = resolve(packageRoot, "src");
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    visit(sourceRoot);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/g)) {
        const target = resolve(dirname(file), match[1]);
        expect(
          target === packageRoot || target.startsWith(`${packageRoot}${sep}`),
          `${relative(packageRoot, file)} imports outside the workspace: ${match[1]}`,
        ).toBe(true);
      }
    }
  });

  it("does not recreate the accidental resolver barrel through text-to-path", () => {
    const source = readFileSync(new URL("./text-to-path.ts", import.meta.url), "utf8");
    expect(source).not.toContain('export * from "./font-resolution.js"');
  });
});
