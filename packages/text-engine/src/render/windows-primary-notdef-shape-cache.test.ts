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

const key = (text: string, primaryIdentity = "system-ui|sf-pro", features?: string[]) =>
  primaryNotdefShapeKey(text, primaryIdentity, 400, 16, 0, 100, undefined, features);

describe("Windows primary .notdef shape state", () => {
  it("arms only the measured system-ui canonical singletons", () => {
    withHostPlatform("win32", () => {
      expect(key("\u{2f800}")).toBeNull(); // no active renderer document
      beginCharacterFallbackDocument();
      try {
        expect(key("\u{2f800}")).not.toBeNull();
        expect(key("\u{2fa00}")).not.toBeNull();
        expect(key("\u{2f900}")).not.toBeNull();
        expect(key("\u{2f800}", "fantasy|sf-pro")).toBeNull();
        expect(key("\u{2f800}", "monospace|sf-pro")).toBeNull();
        expect(key("\u{2f800}", "Segoe UI|sf-pro")).toBeNull();
        expect(key("\u{2f800}x")).toBeNull();
        expect(key("\u0100")).toBeNull();
      } finally {
        endCharacterFallbackDocument();
      }
    });
  });

  it("retains terminal primary shapes across owned documents, but not across sessions or an oracle GC", () => {
    withHostPlatform("win32", () => {
      const session = createFontRendererSession();
      withFontRendererSession(session, () => {
        beginCharacterFallbackDocument();
        try {
          recordPrimaryNotdefShape(key("\u{2f800}"));
          recordPrimaryNotdefShape(key("\u{2fa00}"));
          // U+2F900 selected a real fallback in the native Windows control,
          // so the production splitter must never record its primary pass.
          expect(hasPrimaryNotdefShape(key("\u{2f900}"))).toBe(false);
        } finally {
          endCharacterFallbackDocument();
        }
      });
      withFontRendererSession(session, () => {
        beginCharacterFallbackDocument();
        try {
          expect(hasPrimaryNotdefShape(key("\u{2f800}"))).toBe(true);
          expect(hasPrimaryNotdefShape(key("\u{2fa00}"))).toBe(true);
          expect(hasPrimaryNotdefShape(key("\u{2f900}"))).toBe(false);
          expect(hasPrimaryNotdefShape(key("\u{2f800}", "system-ui|sf-pro", ["-liga"]))).toBe(false);
          clearPrimaryNotdefShapesAfterOracleGc();
          expect(hasPrimaryNotdefShape(key("\u{2f800}"))).toBe(false);
        } finally {
          endCharacterFallbackDocument();
        }
      });
      withFontRendererSession(createFontRendererSession(), () => {
        beginCharacterFallbackDocument();
        try {
          expect(hasPrimaryNotdefShape(key("\u{2fa00}"))).toBe(false);
        } finally {
          endCharacterFallbackDocument();
        }
      });
    });
  });
});
