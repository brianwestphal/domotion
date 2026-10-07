import { describe, expect, it } from "vitest";
import {
  beginCharacterFallbackDocument,
  clearPrimaryNotdefShapesAfterOracleGc,
  createFontRendererSession,
  endCharacterFallbackDocument,
  hasPrimaryNotdefShape,
  primaryNotdefShapeKey,
  recordPrimaryNotdefShape,
  withFontRendererSession,
} from "./character-fallback-cache.js";
import { withHostPlatform } from "./host-platform.js";

const key = (text = "\u{2f900}", size = 16, weight = 400) =>
  primaryNotdefShapeKey(text, "system-ui|sf-pro", weight, size, 0, 100, undefined, undefined);

describe("macOS primary .notdef shape state", () => {
  it("records an eligible canonical run only within an open document", () => {
    withHostPlatform("darwin", () => {
      expect(key()).toBeNull();
      beginCharacterFallbackDocument();
      try {
        const shapeKey = key();
        expect(shapeKey).not.toBeNull();
        expect(hasPrimaryNotdefShape(shapeKey)).toBe(false);
        recordPrimaryNotdefShape(shapeKey);
        expect(hasPrimaryNotdefShape(shapeKey)).toBe(true);
        expect(hasPrimaryNotdefShape(key("\u{2f800}"))).toBe(false);
        expect(hasPrimaryNotdefShape(key("\u{2f900}", 17))).toBe(false);
        expect(hasPrimaryNotdefShape(key("\u{2f900}", 16, 500))).toBe(false);
        expect(
          hasPrimaryNotdefShape(
            primaryNotdefShapeKey("\u{2f900}", "system-ui|sf-pro", 400, 16, 0, 100, undefined, undefined, "rtl"),
          ),
        ).toBe(false);
        expect(primaryNotdefShapeKey("\u{2f900}", "system-ui|sf-pro", 400, 16, 0, 100, undefined, ["chws"])).toBe(
          shapeKey,
        );
        expect(
          primaryNotdefShapeKey("\u{2f900}", "system-ui|sf-pro", 400, 16, 0, 100, undefined, ["ss01", "chws"]),
        ).toBeNull();
        expect(
          primaryNotdefShapeKey("\u{2f900}", "system-ui|sf-pro", 400, 16, 0, 100, undefined, ["-liga", "chws"]),
        ).toBeNull();
        expect(key("\u0100")).toBeNull();
        expect(key("\u{2f900}x")).not.toBeNull();
        const pair = key("\u{2f900}\u{2fa00}");
        expect(pair).not.toBeNull();
        expect(pair).not.toBe(shapeKey);
        recordPrimaryNotdefShape(pair);
        expect(hasPrimaryNotdefShape(pair)).toBe(true);
        expect(hasPrimaryNotdefShape(key("\u{2fa00}\u{2f900}"))).toBe(false);
        expect(
          hasPrimaryNotdefShape(
            primaryNotdefShapeKey(
              "\u{2f900}\u{2fa00}",
              "system-ui|sf-pro",
              400,
              16,
              0,
              100,
              undefined,
              undefined,
              "rtl",
            ),
          ),
        ).toBe(false);
        expect(key("\u{2f900}".repeat(15))).not.toBeNull(); // 30 UTF-16 units
        expect(key("\u{2f900}".repeat(15) + "\uF900")).toBeNull(); // 31 units
        expect(key("\u{2f900}A")).not.toBeNull(); // primary-owned mixed run
        expect(
          primaryNotdefShapeKey("\u{2f900}", "cursive|apple-chancery", 400, 16, 0, 100, undefined, undefined),
        ).toBeNull();
        clearPrimaryNotdefShapesAfterOracleGc();
        expect(hasPrimaryNotdefShape(shapeKey)).toBe(false);
      } finally {
        endCharacterFallbackDocument();
      }
      beginCharacterFallbackDocument();
      try {
        expect(hasPrimaryNotdefShape(key())).toBe(false);
      } finally {
        endCharacterFallbackDocument();
      }
    });
  });

  it("retains the shape result in an owned renderer session across documents", () => {
    withHostPlatform("darwin", () => {
      const session = createFontRendererSession();
      withFontRendererSession(session, () => {
        beginCharacterFallbackDocument();
        try {
          recordPrimaryNotdefShape(key());
        } finally {
          endCharacterFallbackDocument();
        }
      });
      withFontRendererSession(session, () => {
        beginCharacterFallbackDocument();
        try {
          expect(hasPrimaryNotdefShape(key())).toBe(true);
        } finally {
          endCharacterFallbackDocument();
        }
      });
    });
  });
});
