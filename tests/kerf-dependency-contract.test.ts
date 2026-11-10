import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides: { "@kerfjs/ui": { playwright: string } };
}
interface Lockfile {
  packages: Record<string, { version?: string }>;
}
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lockfile;

describe("Kerf dependency and Chromium ownership", () => {
  it("keeps every installed Kerf member at one exact declared and locked beta", () => {
    const versions = [
      manifest.dependencies.kerfjs,
      manifest.devDependencies["@kerfjs/ui"],
      manifest.devDependencies["eslint-plugin-kerfjs"],
    ];
    expect(versions.every((version) => /^5\.0\.0-beta\.\d+$/.test(version))).toBe(true);
    expect(new Set(versions).size).toBe(1);
    for (const name of ["kerfjs", "@kerfjs/ui", "eslint-plugin-kerfjs"]) {
      const installed = JSON.parse(
        readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"),
      ) as { version: string };
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(versions[0]);
      expect(installed.version, name).toBe(versions[0]);
    }
  });

  it("keeps the optional UI peer on the capture-owned Playwright browser", () => {
    const version = lock.packages["node_modules/@playwright/test"]?.version;
    expect(version).toBeTruthy();
    expect(manifest.overrides["@kerfjs/ui"].playwright).toBe(version);
    expect(lock.packages["node_modules/playwright"]?.version).toBe(version);
    expect(lock.packages["node_modules/playwright-core"]?.version).toBe(version);
    expect(
      Object.keys(lock.packages).filter((path) => path.endsWith("/playwright") || path.endsWith("/playwright-core")),
    ).toHaveLength(2);
  });
});
