import { afterEach, describe, expect, it } from "vitest";
import {
  getRenderTextMode,
  getSessionGenericFamilyOverrides,
  getSystemFallbackResolution,
  setRenderTextMode,
  setSessionGenericFamilyOverrides,
  setSystemFallbackResolution,
  withRenderTextMode,
  withSessionGenericFamilyOverrides,
  withSystemFallbackResolution,
  type SessionGenericFamilyOverrides,
} from "./font-resolution.js";
import { hostPlatform, withHostPlatform } from "./host-platform.js";
import { invokeSynchronousCallback } from "./synchronous-scope.js";

const EMPTY_OVERRIDES: SessionGenericFamilyOverrides = {
  common: new Map(),
  byScript: new Map(),
};
const ORIGINAL_TEXT_MODE = getRenderTextMode();
const ORIGINAL_FALLBACK_RESOLUTION = getSystemFallbackResolution();
const ORIGINAL_SESSION_OVERRIDES = getSessionGenericFamilyOverrides();

afterEach(() => {
  setRenderTextMode(ORIGINAL_TEXT_MODE);
  setSystemFallbackResolution(ORIGINAL_FALLBACK_RESOLUTION);
  setSessionGenericFamilyOverrides(ORIGINAL_SESSION_OVERRIDES);
});

describe("synchronous renderer-state scope contract (DM-2637)", () => {
  it("rejects native Promises and custom thenables at runtime", () => {
    expect(() => invokeSynchronousCallback(
      "testScope",
      (() => Promise.resolve(1)) as unknown as () => number,
    )).toThrow(/testScope callback must be synchronous; Promise-like results/);

    expect(() => invokeSynchronousCallback(
      "testScope",
      (() => ({ then() {} })) as unknown as () => number,
    )).toThrow(/testScope callback must be synchronous; Promise-like results/);
  });

  it("rejects async render-text-mode work and restores before its continuation", async () => {
    setRenderTextMode("embedded-font");
    let seenAfterAwait: string | null = null;
    expect(() => withRenderTextMode(
      "paths",
      (async () => {
        expect(getRenderTextMode()).toBe("paths");
        await Promise.resolve();
        seenAfterAwait = getRenderTextMode();
      }) as unknown as () => void,
    )).toThrow(/withRenderTextMode callback must be synchronous/);
    expect(getRenderTextMode()).toBe("embedded-font");
    await Promise.resolve();
    expect(seenAfterAwait).toBe("embedded-font");
  });

  it("rejects async fallback-resolution work and restores before its continuation", async () => {
    setSystemFallbackResolution(false);
    let seenAfterAwait: boolean | null = null;
    expect(() => withSystemFallbackResolution(
      true,
      (async () => {
        expect(getSystemFallbackResolution()).toBe(true);
        await Promise.resolve();
        seenAfterAwait = getSystemFallbackResolution();
      }) as unknown as () => void,
    )).toThrow(/withSystemFallbackResolution callback must be synchronous/);
    expect(getSystemFallbackResolution()).toBe(false);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(false);
  });

  it("rejects async session-generic work and restores before its continuation", async () => {
    const prior: SessionGenericFamilyOverrides = {
      common: new Map([["serif", "prior"]]),
      byScript: new Map(),
    };
    setSessionGenericFamilyOverrides(prior);
    let seenAfterAwait: SessionGenericFamilyOverrides | null | undefined;
    expect(() => withSessionGenericFamilyOverrides(
      EMPTY_OVERRIDES,
      (async () => {
        expect(getSessionGenericFamilyOverrides()).toBe(EMPTY_OVERRIDES);
        await Promise.resolve();
        seenAfterAwait = getSessionGenericFamilyOverrides();
      }) as unknown as () => void,
    )).toThrow(/withSessionGenericFamilyOverrides callback must be synchronous/);
    expect(getSessionGenericFamilyOverrides()).toBe(prior);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(prior);
  });

  it("rejects async host-platform work and restores before its continuation", async () => {
    const prior = hostPlatform();
    const temporary = prior === "linux" ? "darwin" : "linux";
    let seenAfterAwait: NodeJS.Platform | null = null;
    expect(() => withHostPlatform(
      temporary,
      (async () => {
        expect(hostPlatform()).toBe(temporary);
        await Promise.resolve();
        seenAfterAwait = hostPlatform();
      }) as unknown as () => void,
    )).toThrow(/withHostPlatform callback must be synchronous/);
    expect(hostPlatform()).toBe(prior);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(prior);
  });
});

// Compile-time half of the public contract. These calls stay unreachable so
// Vitest does not execute them; `tsc --noEmit` must consume every expectation.
if (false) {
  // @ts-expect-error DM-2637: renderer state scopes do not cross await points.
  withRenderTextMode("paths", async () => undefined);
  // @ts-expect-error DM-2637: renderer state scopes do not cross await points.
  withSystemFallbackResolution(true, async () => undefined);
  // @ts-expect-error DM-2637: renderer state scopes do not cross await points.
  withSessionGenericFamilyOverrides(EMPTY_OVERRIDES, async () => undefined);
  // @ts-expect-error DM-2637: renderer state scopes do not cross await points.
  withHostPlatform("linux", async () => undefined);
}
