import { describe, expect, it } from "vitest";
import {
  beginCharacterFallbackDocument,
  collectDarwinFontDataAfterOracleGc,
  createFontRendererSession,
  endCharacterFallbackDocument,
  withFontRendererSession,
} from "./character-fallback-cache.js";
import {
  DARWIN_FONT_DATA_STRONG_LRU_SIZE,
  darwinFontDataIdentity,
  darwinFontDataLruForTest,
  darwinFontDescriptionKey,
  hasWarmDarwinSystemUiAlias,
  recordDarwinFontDataUse,
  warmDarwinSystemUiAlias,
} from "./darwin-font-data-lifetime.js";
import { withHostPlatform } from "./host-platform.js";

const regular = { weight: 400, size: 16, slant: 0, stretch: 100 };
const bold = { ...regular, weight: 700 };
const large = { ...regular, size: 32 };
const italic = { ...regular, slant: 1 };
const condensed = { ...regular, stretch: 75 };
const varied = { ...regular, variationSettings: { wght: 500 } };
const ui = darwinFontDataIdentity("sf-pro", 400, 16, 0, 100);
const face = (index: number): string => darwinFontDataIdentity(`Other-${index}`, 400, 16, 0, 100);

function inDocument(run: () => void): void {
  withHostPlatform("darwin", () => {
    beginCharacterFallbackDocument();
    try {
      run();
    } finally {
      endCharacterFallbackDocument();
    }
  });
}

describe("Chromium 147 macOS FontData strong LRU and platform aliases", () => {
  it("keys a warm alias by weight, size, slant, and stretch", () => {
    inDocument(() => {
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(false);
      warmDarwinSystemUiAlias(regular);
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true);
      for (const other of [bold, large, italic, condensed, varied])
        expect(hasWarmDarwinSystemUiAlias(other)).toBe(false);
      warmDarwinSystemUiAlias(bold);
      expect(hasWarmDarwinSystemUiAlias(bold)).toBe(true);
      expect(hasWarmDarwinSystemUiAlias(large)).toBe(false);
    });
  });

  it("normalizes variation axis order and ignores internal size markers", () => {
    const a = { ...regular, variationSettings: { wght: 500, wdth: 90 } };
    const b = { ...regular, variationSettings: { __dmComputedFontSize: 16, wdth: 90, wght: 500 } };
    expect(darwinFontDescriptionKey(a)).toBe(darwinFontDescriptionKey(b));
    expect(darwinFontDataIdentity("sf-pro", 400, 16, 0, 100, a.variationSettings)).toBe(
      darwinFontDataIdentity("sf-pro", 400, 16, 0, 100, b.variationSettings),
    );
  });

  it("retains a warmed UI entry through GC while it is among the latest 64 identities", () => {
    inDocument(() => {
      warmDarwinSystemUiAlias(regular);
      recordDarwinFontDataUse(ui);
      for (let i = 0; i < DARWIN_FONT_DATA_STRONG_LRU_SIZE - 1; i++) recordDarwinFontDataUse(face(i));
      expect(darwinFontDataLruForTest()).toHaveLength(64);
      collectDarwinFontDataAfterOracleGc();
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true);

      recordDarwinFontDataUse(ui);
      recordDarwinFontDataUse(face(0));
      recordDarwinFontDataUse(face(64));
      collectDarwinFontDataAfterOracleGc();
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true);
    });
  });

  it("expires only the evicted description after document GC", () => {
    inDocument(() => {
      warmDarwinSystemUiAlias(regular);
      warmDarwinSystemUiAlias(bold);
      recordDarwinFontDataUse(ui);
      recordDarwinFontDataUse(darwinFontDataIdentity("sf-pro", 700, 16, 0, 100));
      for (let i = 0; i < 63; i++) recordDarwinFontDataUse(face(i));
      recordDarwinFontDataUse(face(0)); // another list's Get refreshes that face
      expect(darwinFontDataLruForTest()).not.toContain(ui);
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true); // old document still owns it
      collectDarwinFontDataAfterOracleGc();
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(false);
      expect(hasWarmDarwinSystemUiAlias(bold)).toBe(true);
    });
  });

  it("refreshes interleaved acquisition instead of evicting an old UI position", () => {
    inDocument(() => {
      warmDarwinSystemUiAlias(regular);
      recordDarwinFontDataUse(ui);
      for (let i = 0; i < 63; i++) recordDarwinFontDataUse(face(i));
      recordDarwinFontDataUse(ui); // a second fallback list reacquires UI
      recordDarwinFontDataUse(face(63));
      expect(darwinFontDataLruForTest()).toContain(ui);
      collectDarwinFontDataAfterOracleGc();
      expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true);
    });
  });

  it("isolates renderers and reuses one renderer across documents", () => {
    withHostPlatform("darwin", () => {
      const first = createFontRendererSession();
      const second = createFontRendererSession();
      const documentIn = (session: typeof first, run: () => void): void =>
        withFontRendererSession(session, () => {
          beginCharacterFallbackDocument();
          try {
            run();
          } finally {
            endCharacterFallbackDocument();
          }
        });

      documentIn(first, () => {
        warmDarwinSystemUiAlias(regular);
        recordDarwinFontDataUse(ui);
      });
      documentIn(second, () => expect(hasWarmDarwinSystemUiAlias(regular)).toBe(false));
      documentIn(first, () => {
        expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true);
        collectDarwinFontDataAfterOracleGc();
        expect(hasWarmDarwinSystemUiAlias(regular)).toBe(true);
      });
    });
  });
});
