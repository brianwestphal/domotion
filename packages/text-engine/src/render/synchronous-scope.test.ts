import { afterEach, describe, expect, it } from "vitest";
import {
  createFontRendererSession,
  getRenderTextMode,
  getSessionGenericFamilyOverrides,
  getSystemFallbackResolution,
  setRenderTextMode,
  setSessionGenericFamilyOverrides,
  setSystemFallbackResolution,
  withFontRendererSession,
  withRenderTextMode,
  withSessionGenericFamilyOverrides,
  withSystemFallbackResolution,
  type SessionGenericFamilyOverrides,
} from "./font-resolution.js";
import { hostPlatform, withHostPlatform } from "./host-platform.js";
import { withHintedSubsetEnabled } from "./embedded-font-builder.js";
import { invokeSynchronousCallback } from "./synchronous-scope.js";
import { visualTextOnlyHiddenAttr, withTextEngineVisualSemanticsSuppressed } from "./text-semantics.js";

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
    expect(() => invokeSynchronousCallback("testScope", (() => Promise.resolve(1)) as unknown as () => number)).toThrow(
      /testScope callback must be synchronous; Promise-like results/,
    );

    expect(() => invokeSynchronousCallback("testScope", (() => ({ then() {} })) as unknown as () => number)).toThrow(
      /testScope callback must be synchronous; Promise-like results/,
    );
  });

  it("rejects async render-text-mode work and restores before its continuation", async () => {
    setRenderTextMode("embedded-font");
    let seenAfterAwait: string | null = null;
    expect(() =>
      withRenderTextMode("paths", (async () => {
        expect(getRenderTextMode()).toBe("paths");
        await Promise.resolve();
        seenAfterAwait = getRenderTextMode();
      }) as unknown as () => void),
    ).toThrow(/withRenderTextMode callback must be synchronous/);
    expect(getRenderTextMode()).toBe("embedded-font");
    await Promise.resolve();
    expect(seenAfterAwait).toBe("embedded-font");
  });

  it("rejects async fallback-resolution work and restores before its continuation", async () => {
    setSystemFallbackResolution(false);
    let seenAfterAwait: boolean | null = null;
    expect(() =>
      withSystemFallbackResolution(true, (async () => {
        expect(getSystemFallbackResolution()).toBe(true);
        await Promise.resolve();
        seenAfterAwait = getSystemFallbackResolution();
      }) as unknown as () => void),
    ).toThrow(/withSystemFallbackResolution callback must be synchronous/);
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
    expect(() =>
      withSessionGenericFamilyOverrides(EMPTY_OVERRIDES, (async () => {
        expect(getSessionGenericFamilyOverrides()).toBe(EMPTY_OVERRIDES);
        await Promise.resolve();
        seenAfterAwait = getSessionGenericFamilyOverrides();
      }) as unknown as () => void),
    ).toThrow(/withSessionGenericFamilyOverrides callback must be synchronous/);
    expect(getSessionGenericFamilyOverrides()).toBe(prior);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(prior);
  });

  it("rejects async host-platform work and restores before its continuation", async () => {
    const prior = hostPlatform();
    const temporary = prior === "linux" ? "darwin" : "linux";
    let seenAfterAwait: NodeJS.Platform | null = null;
    expect(() =>
      withHostPlatform(temporary, (async () => {
        expect(hostPlatform()).toBe(temporary);
        await Promise.resolve();
        seenAfterAwait = hostPlatform();
      }) as unknown as () => void),
    ).toThrow(/withHostPlatform callback must be synchronous/);
    expect(hostPlatform()).toBe(prior);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(prior);
  });

  it("rejects async visual-semantics work and restores before its continuation", async () => {
    let seenAfterAwait: string | null = null;
    expect(() =>
      withTextEngineVisualSemanticsSuppressed((async () => {
        expect(visualTextOnlyHiddenAttr()).toBe(` aria-hidden="true"`);
        await Promise.resolve();
        seenAfterAwait = visualTextOnlyHiddenAttr();
      }) as unknown as () => void),
    ).toThrow(/withTextEngineVisualSemanticsSuppressed callback must be synchronous/);
    expect(visualTextOnlyHiddenAttr()).toBe("");
    await Promise.resolve();
    expect(seenAfterAwait).toBe("");
  });

  it("nests visual-semantics suppression and returns the callback value", () => {
    const seen = withTextEngineVisualSemanticsSuppressed(() =>
      withTextEngineVisualSemanticsSuppressed(() => visualTextOnlyHiddenAttr()),
    );
    expect(seen).toBe(` aria-hidden="true"`);
    expect(visualTextOnlyHiddenAttr()).toBe("");
  });

  it("rejects async renderer-session work and restores the request before its continuation", async () => {
    const session = createFontRendererSession();
    expect(() => withFontRendererSession(session, (async () => undefined) as unknown as () => void)).toThrow(
      /withFontRendererSession callback must be synchronous/,
    );
    // The restored (null) request means a following document does not reuse `session`'s cache.
    expect(withFontRendererSession(session, () => 7)).toBe(7);
  });

  it("scopes the hinted-subset override, rejects async callbacks, and restores after throws", async () => {
    expect(withHintedSubsetEnabled(false, () => "ok")).toBe("ok");
    expect(() =>
      withHintedSubsetEnabled(false, () => {
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(() => withHintedSubsetEnabled(false, (async () => undefined) as unknown as () => void)).toThrow(
      /withHintedSubsetEnabled callback must be synchronous/,
    );
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
  // @ts-expect-error renderer state scopes do not cross await points.
  withTextEngineVisualSemanticsSuppressed(async () => undefined);
  // @ts-expect-error renderer state scopes do not cross await points.
  withFontRendererSession(createFontRendererSession(), async () => undefined);
  // @ts-expect-error renderer state scopes do not cross await points.
  withHintedSubsetEnabled(true, async () => undefined);
}
