import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: childProcess.execFileSync };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]): boolean => {
      // Force the Linux table through fontconfig even on a Linux host whose
      // canonical distro paths exist. Keep the synthetic returned file real.
      if (String(path).startsWith("/usr/share/fonts/")) return false;
      return actual.existsSync(path);
    },
  };
});

import { clearFontResolutionCaches, resolveFontSpec } from "./font-resolution.js";
import { withHostPlatform } from "./host-platform.js";

afterEach(() => {
  childProcess.execFileSync.mockReset();
  clearFontResolutionCaches();
});

describe("Linux fc-match pattern memo", () => {
  it("launches once per exact pattern, including empty and error results, until cache clear", () => {
    const existingFile = fileURLToPath(import.meta.url);
    childProcess.execFileSync.mockImplementation((_command: string, args: string[]) => {
      const pattern = args[2];
      if (pattern === "Liberation Sans") return `${existingFile}\tDmTestFace`;
      if (pattern === "Liberation Serif") return "";
      throw new Error("fontconfig unavailable");
    });

    withHostPlatform("linux", () => {
      expect(resolveFontSpec("sf-pro")).toMatchObject({
        path: existingFile,
        postscriptName: "DmTestFace",
      });
      expect(resolveFontSpec("helvetica")).toMatchObject({
        path: existingFile,
        postscriptName: "DmTestFace",
      });

      expect(resolveFontSpec("times")).toBeNull();
      expect(resolveFontSpec("times-new-roman")).toBeNull();

      expect(resolveFontSpec("cjk")).toBeNull();
      expect(resolveFontSpec("cjk-bold")).toBeNull();
    });

    expect(childProcess.execFileSync.mock.calls.map((call) => call[1][2])).toEqual([
      "sans-serif:charset=4e00",
      "Liberation Sans",
      "Liberation Serif",
      "WenQuanYi Zen Hei",
    ]);

    clearFontResolutionCaches();
    withHostPlatform("linux", () => expect(resolveFontSpec("arial")).not.toBeNull());
    expect(childProcess.execFileSync.mock.calls.map((call) => call[1][2])).toEqual([
      "sans-serif:charset=4e00",
      "Liberation Sans",
      "Liberation Serif",
      "WenQuanYi Zen Hei",
      "Liberation Sans",
    ]);
  });
});
