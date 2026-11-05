import { afterEach, describe, expect, it, vi } from "vitest";

// DM-89XW9B: docs claimed `DOMOTION_SYSTEM_FALLBACK=0` disables the live
// system-fallback resolver everywhere, but the flag is read only on Linux and
// Windows — macOS ignores it (disable there with `DOMOTION_DISABLE_HELPER=1` or
// `setSystemFallbackResolutionEnabled(false)`). A macOS "disable it and require
// the answer to move" check run with the env var therefore moved nothing. Pin
// the per-platform contract the docs now state. The flag is evaluated at module
// load, so each case re-imports `font-spec.ts` under a stubbed environment.
async function loadFlag(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("DOMOTION_SYSTEM_FALLBACK", undefined);
  else vi.stubEnv("DOMOTION_SYSTEM_FALLBACK", value);
  const mod = await import("./font-spec.js");
  return mod.systemFallbackResolutionEnabled;
}

describe("DOMOTION_SYSTEM_FALLBACK per-platform contract (DM-89XW9B)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the resolver on when the variable is unset", async () => {
    expect(await loadFlag(undefined)).toBe(true);
  });

  it.runIf(process.platform === "darwin")("is ignored on macOS", async () => {
    expect(await loadFlag("0")).toBe(true);
  });

  it.runIf(process.platform === "linux" || process.platform === "win32")(
    "turns the resolver off on Linux and Windows",
    async () => {
      expect(await loadFlag("0")).toBe(false);
    },
  );
});
