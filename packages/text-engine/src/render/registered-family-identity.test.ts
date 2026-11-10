import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureFontFamilyStack, serializeCapturedFontFamilyStack } from "../font-family-stack.js";
import { resolveFont, resolveFontKey } from "./family-match.js";
import { isolatedPrimaryFontMetrics } from "./isolated-primary-font-metrics.js";
import {
  createTextEngineSession,
  registerTextEngineWebfont,
  registerTextEngineLocalFontAlias,
  withTextEngineDocument,
} from "./text-engine.js";
import {
  clearWebfonts,
  registerLocalFontAlias,
  registerWebfont,
  restoreFontRegistrations,
  snapshotFontRegistrations,
} from "./webfont-registry.js";

const mono = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url));
const serif = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url));
const css = (name: string): string =>
  serializeCapturedFontFamilyStack({
    source: "blink-font-family-stack-v1",
    entries: [{ name, type: "family-name" }],
    genericFamily: "none",
  });
let saved: ReturnType<typeof snapshotFontRegistrations>;
beforeEach(() => {
  saved = snapshotFontRegistrations();
  clearWebfonts();
});
afterEach(() => restoreFontRegistrations(saved));

describe("DM-N80HJW decoded registered-family identity", () => {
  it("keeps decoded family identity in independently registered engine sessions", () => {
    const first = createTextEngineSession(),
      second = createTextEngineSession();
    registerTextEngineWebfont(first, { decodedName: " Face " }, 400, "normal", mono);
    registerTextEngineWebfont(second, { decodedName: " Face " }, 400, "normal", serif);
    registerTextEngineLocalFontAlias(first, { decodedName: " Alias " }, "arial");
    const before = snapshotFontRegistrations();
    for (const [session, advance] of [
      [first, 600],
      [second, 953],
    ] as const) {
      withTextEngineDocument({ session }, () => {
        expect(resolveFont(css(" Face "), 400, 20, 0)!.glyphForCodePoint(0x6d).advanceWidth).toBe(advance);
        if (session === first) expect(resolveFontKey(css(" Alias "))).toBe("localalias: alias ");
      });
      expect(snapshotFontRegistrations()).toEqual(before);
    }
  });
  it.each([" Face ", " Face", "Face ", "\tFace\t", "\u00a0Face\u00a0", " ", "", '"Quote"'])(
    "keeps exact data distinct from trimmed/quote-stripped names: %j",
    (name) => {
      registerWebfont({ decodedName: name.trim().replace(/^["']|["']$/g, "") }, 400, "normal", serif);
      registerWebfont({ decodedName: name }, 400, "normal", mono);
      expect(resolveFontKey(css(name))).toBe("webfont:" + name.toLowerCase());
      const font = resolveFont(css(name), 400, 20, 0)!;
      expect(font.glyphForCodePoint(0x6d).advanceWidth).toBe(600);
      expect(captureFontFamilyStack(css(name)).entries).toEqual([{ name, type: "family-name" }]);
    },
  );
  it("preserves legacy quote syntax while supporting literal quote characters explicitly", () => {
    registerWebfont('"Quote"', 400, "normal", serif);
    registerWebfont({ decodedName: '"Quote"' }, 400, "normal", mono);
    expect(resolveFont(css("Quote"), 400, 20, 0)!.glyphForCodePoint(0x6d).advanceWidth).toBe(953);
    expect(resolveFont(css('"Quote"'), 400, 20, 0)!.glyphForCodePoint(0x6d).advanceWidth).toBe(600);
  });
  it("keeps decoded local aliases separate while retaining legacy string normalization", () => {
    registerLocalFontAlias('  "Alias" ', "arial");
    registerLocalFontAlias({ decodedName: '  "Alias" ' }, "georgia");
    registerLocalFontAlias({ decodedName: " Alias " }, "menlo");
    expect(resolveFontKey(css("Alias"))).toBe("localalias:alias");
    expect(resolveFontKey(css('  "Alias" '))).toBe('localalias:  "alias" ');
    expect(resolveFontKey(css(" Alias "))).toBe("localalias: alias ");
  });
  it("does not confuse empty literal names with an absent family stack", () => {
    registerWebfont({ decodedName: "" }, 400, "normal", mono);
    expect(resolveFontKey('""')).toBe("webfont:");
    expect(resolveFontKey("")).not.toBe("webfont:");
  });
  it("restores caller registrations after isolated exact-name success and failure", () => {
    registerWebfont({ decodedName: " Face " }, 400, "normal", serif);
    const before = snapshotFontRegistrations();
    const request = { fontFamily: css(" Face "), fontSize: 20, fontWeight: 400, italic: false };
    expect(isolatedPrimaryFontMetrics({ ...request, fontFaces: [{ family: " Face ", data: mono }] })?.zeroWidth).toBe(
      12,
    );
    expect(snapshotFontRegistrations()).toEqual(before);
    expect(
      isolatedPrimaryFontMetrics({ ...request, fontFaces: [{ family: " Face ", data: Buffer.from("bad") }] }),
    ).toBeNull();
    expect(snapshotFontRegistrations()).toEqual(before);
    expect(resolveFont(css(" Face "), 400, 20, 0)!.glyphForCodePoint(0x6d).advanceWidth).toBe(953);
  });
});
