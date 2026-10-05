import { describe, expect, it } from "vitest";
import {
  beginCharacterFallbackDocument,
  collectDarwinFontDataAfterOracleGc,
  endCharacterFallbackDocument,
} from "./character-fallback-cache.js";
import {
  DARWIN_FONT_DATA_STRONG_LRU_SIZE,
  darwinFontDataIdentity,
  darwinFontDataLruForTest,
  recordDarwinFontDataUse,
} from "./darwin-font-data-lifetime.js";
import { darwinSystemUiPlatformCacheWarm, setDarwinSystemUiPlatformCacheWarm } from "./font-instance.js";
import { withHostPlatform } from "./host-platform.js";

const ui = darwinFontDataIdentity("sf-pro", 400, 16, 0, 100);
const face = (index: number): string => darwinFontDataIdentity(`Other-${index}`, 400, 16, 0, 100);

describe("Chromium 147 macOS FontData strong LRU", () => {
  it("retains a warmed UI platform entry through GC while it is one of the latest 64 identities", () => {
    const old = darwinSystemUiPlatformCacheWarm;
    try {
      withHostPlatform("darwin", () => {
        beginCharacterFallbackDocument();
        try {
          setDarwinSystemUiPlatformCacheWarm(true);
          recordDarwinFontDataUse(ui);
          for (let i = 0; i < DARWIN_FONT_DATA_STRONG_LRU_SIZE - 1; i++) recordDarwinFontDataUse(face(i));
          expect(darwinFontDataLruForTest()).toHaveLength(64);
          collectDarwinFontDataAfterOracleGc();
          expect(darwinSystemUiPlatformCacheWarm).toBe(true);

          // A new document reacquires existing data and moves it to the head.
          recordDarwinFontDataUse(ui);
          recordDarwinFontDataUse(face(0));
          recordDarwinFontDataUse(face(64));
          collectDarwinFontDataAfterOracleGc();
          expect(darwinSystemUiPlatformCacheWarm).toBe(true);
        } finally {
          endCharacterFallbackDocument();
        }
      });
    } finally {
      setDarwinSystemUiPlatformCacheWarm(old);
    }
  });

  it("expires the weak quoted-family lookup only after 64 newer identities and document GC", () => {
    const old = darwinSystemUiPlatformCacheWarm;
    try {
      withHostPlatform("darwin", () => {
        beginCharacterFallbackDocument();
        try {
          setDarwinSystemUiPlatformCacheWarm(true);
          recordDarwinFontDataUse(ui);
          for (let i = 0; i < 63; i++) recordDarwinFontDataUse(face(i));
          recordDarwinFontDataUse(face(0)); // another list's explicit Get refreshes that face
          expect(darwinFontDataLruForTest()[0]).toBe(ui);
          recordDarwinFontDataUse(face(63));
          expect(darwinFontDataLruForTest()).not.toContain(ui);
          expect(darwinSystemUiPlatformCacheWarm).toBe(true); // document still owns the font
          collectDarwinFontDataAfterOracleGc();
          expect(darwinSystemUiPlatformCacheWarm).toBe(false);
        } finally {
          endCharacterFallbackDocument();
        }
      });
    } finally {
      setDarwinSystemUiPlatformCacheWarm(old);
    }
  });

  it("refreshes an interleaved UI acquisition instead of evicting it with an old position", () => {
    const old = darwinSystemUiPlatformCacheWarm;
    try {
      withHostPlatform("darwin", () => {
        beginCharacterFallbackDocument();
        try {
          setDarwinSystemUiPlatformCacheWarm(true);
          recordDarwinFontDataUse(ui);
          for (let i = 0; i < 63; i++) recordDarwinFontDataUse(face(i));
          recordDarwinFontDataUse(ui); // a second fallback list reacquires UI
          recordDarwinFontDataUse(face(63));
          expect(darwinFontDataLruForTest()).toContain(ui);
          collectDarwinFontDataAfterOracleGc();
          expect(darwinSystemUiPlatformCacheWarm).toBe(true);
        } finally {
          endCharacterFallbackDocument();
        }
      });
    } finally {
      setDarwinSystemUiPlatformCacheWarm(old);
    }
  });
});
