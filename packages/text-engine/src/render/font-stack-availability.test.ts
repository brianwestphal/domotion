import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      // DM-V6R5PM: even Linux hosts must use the controlled fontconfig answer.
      if (String(path).startsWith("/usr/share/fonts/")) return false;
      return actual.existsSync(path);
    },
  };
});

import { withHostPlatform } from "./host-platform.js";
import { clearFontResolutionCaches, getFontInstance, resolveFont, resolveFontKey } from "./font-resolution.js";

const serifPath = fileURLToPath(
  new URL("../../assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url),
);

beforeEach(() => {
  // Exercise real font loading without acquiring a helper for the pretend OS.
  vi.stubEnv("DOMOTION_DISABLE_HELPER", "1");
  clearFontResolutionCaches();
  childProcess.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command === "fc-match" && args[2] === "Liberation Serif") return `${serifPath}\tIBMPlexSerif-Regular`;
    throw new Error("fontconfig unavailable");
  });
});

afterEach(() => {
  childProcess.execFileSync.mockReset();
  vi.unstubAllEnvs();
  clearFontResolutionCaches();
});

describe("CSS family-stack availability", () => {
  it("continues after a recognized family has no loadable host face (DM-2275)", () => {
    withHostPlatform("linux", () => {
      expect(resolveFontKey('"Playfair Display"')).toBe("playfair-display");
      expect(getFontInstance("playfair-display", 400, 32)).toBeNull();
    });
    const face = withHostPlatform("linux", () => resolveFont('"Playfair Display", Times, serif', 400, 32));
    const next = withHostPlatform("linux", () => resolveFont("Times, serif", 400, 32));

    expect(face).not.toBeNull();
    expect(face?.postscriptName).toBe("IBMPlexSerif-Regular");
    expect(face?.postscriptName).toBe(next?.postscriptName);
    expect(face?.postscriptName?.toLowerCase()).not.toContain("playfair");
  });

  it("returns null when the remaining family and standard fallback are unavailable", () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error("fontconfig unavailable");
    });
    expect(withHostPlatform("linux", () => resolveFont('"Playfair Display", Times, serif', 400, 32))).toBeNull();
  });
});
