import { afterEach, describe, expect, it } from "vitest";
import {
  clearFontResolutionCaches,
  createFontRendererSession,
  getFontInstance,
  getFontSourceInfo,
  invalidateFontEnvironmentCaches,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  withFontRendererSession,
} from "./font-resolution.js";
import { isGlyphHelperAvailable, resolveInstalledFont } from "./glyph-helper.js";
import {
  clearGlyphDefs,
  getTextRunProvenance,
  renderTextAsPath,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "./text-to-path.js";

// Blink exhausts the declared family group before CTFontCreateForString system
// fallback (`font_fallback_iterator.cc:120-178`, Chromium 7d859f271c). These
// tests pin the renderer seam: the exact MatchFontFamily descriptor/PostScript
// member must survive key materialization, later declared-family fallback, and
// renderer-session cache warming. A matching glyph id or advance alone is not
// enough: Hiragino Kaku Gothic ProN and Hiragino Sans intentionally provide the
// discriminating same-gid/same-advance, different-face case.
const available = process.platform === "darwin" && isGlyphHelperAvailable();
const describeMac = available ? describe : describe.skip;
const initialHiddenFamilies = process.env.DOMOTION_HIDE_FAMILIES;

interface FaceIdentity {
  key: string;
  postscriptName: string | null;
  path: string | null;
  glyphs: Array<{ id: number; advance: number | undefined }>;
}

function faceIdentity(key: string, cps: number[]): FaceIdentity {
  const font = getFontInstance(key, 400, 32, 0);
  expect(font, key).not.toBeNull();
  const source = getFontSourceInfo(font);
  return {
    key,
    postscriptName: font?.instantiatedPostscriptName ?? font?.postscriptName ?? null,
    path: source?.path ?? null,
    glyphs: cps.map((cp) => {
      const glyph = font!.glyphForCodePoint(cp);
      return { id: glyph.id, advance: glyph.advanceWidth };
    }),
  };
}

function declaredFallbackIdentity(stack: string, cp: number): FaceIdentity {
  const primaryKey = resolveFontKey(stack);
  const primary = resolveFont(stack, 400, 32, 0);
  expect(primary).not.toBeNull();
  const resolution = resolveFontForCodepoint(
    cp, primary!, primaryKey, 400, 32, 0, undefined, undefined,
    resolveFontKeyChain(stack), false, 100, undefined, stack,
  );
  expect(resolution.covered).toBe(true);
  const font = resolution.fontOverride
    ?? (resolution.key === primaryKey ? primary : getFontInstance(resolution.key, 400, 32, 0));
  expect(font).not.toBeNull();
  const source = getFontSourceInfo(font);
  const glyph = font!.glyphForCodePoint(cp);
  return {
    key: resolution.key,
    postscriptName: font?.instantiatedPostscriptName ?? font?.postscriptName ?? null,
    path: source?.path ?? null,
    glyphs: [{ id: glyph.id, advance: glyph.advanceWidth }],
  };
}

function renderedIdentity(stack: string, text: string) {
  clearGlyphDefs();
  resetTextRunProvenance();
  const markup = renderTextAsPath(text, 0, 40, {
    fontFamily: stack, fontSize: 32, fontWeight: "400", fill: "#000",
  });
  expect(markup).not.toBeNull();
  const runs = getTextRunProvenance().runs;
  expect(runs).toHaveLength(1);
  return {
    selected: runs[0]!.selected,
    glyphs: runs[0]!.glyphs.map((glyph) => ({ id: glyph.id, advance: glyph.xAdvance })),
  };
}

afterEach(() => {
  setTextRunProvenanceEnabled(false);
  setRenderTextMode("paths");
  if (initialHiddenFamilies == null) delete process.env.DOMOTION_HIDE_FAMILIES;
  else process.env.DOMOTION_HIDE_FAMILIES = initialHiddenFamilies;
  invalidateFontEnvironmentCaches();
});

describeMac("exact macOS named-family face identity", () => {
  it("keeps Hiragino Kaku Gothic ProN distinct from Hiragino Sans", () => {
    const stack = '"Hiragino Kaku Gothic ProN", Helvetica';
    const key = resolveFontKey(stack);
    expect(key).toBe("sysfb:HiraKakuProN-W3");
    expect(resolveFontKeyChain(stack)[0]).toBe(key);

    const identity = faceIdentity(key, [0x1f100, 0x1f11c]);
    expect(identity.postscriptName).toBe("HiraKakuProN-W3");
    expect(identity.glyphs).toEqual([
      { id: 8061, advance: 1000 },
      { id: 10016, advance: 1000 },
    ]);

    // This is the false-positive trap from the regression: the collapsed face
    // has the same gids and advances, so only exact PostScript/source identity
    // proves the declared family was preserved.
    const collapsed = faceIdentity("hiragino-jp", [0x1f100, 0x1f11c]);
    expect(collapsed.postscriptName).toBe("HiraginoSans-W4");
    expect(collapsed.postscriptName).not.toBe(identity.postscriptName);
    expect(collapsed.glyphs).toEqual(identity.glyphs);
  });

  it("uses a later exact named family before entering system fallback", () => {
    const identity = declaredFallbackIdentity(
      'Times, "Hiragino Kaku Gothic ProN", sans-serif', 0x1f100,
    );
    expect(identity.key).toBe("sysfb:HiraKakuProN-W3");
    expect(identity.postscriptName).toBe("HiraKakuProN-W3");
    expect(identity.glyphs).toEqual([{ id: 8061, advance: 1000 }]);
  });

  it("preserves an installed SF Pro Text optical face exactly", () => {
    const installed = resolveInstalledFont("SF Pro Text");
    if (installed?.postscriptName !== "SFProText-Regular") return;

    const stack = '"SF Pro Text", Helvetica';
    const key = resolveFontKey(stack);
    expect(key).toBe("sysfb:SFProText-Regular");
    expect(resolveFontKeyChain(stack)[0]).toBe(key);
    const identity = faceIdentity(key, [0x2c62, 0x2c65]);
    expect(identity.postscriptName).toBe("SFProText-Regular");
    expect(identity.path).toBe(installed.path);
    expect(identity.glyphs).toEqual([
      { id: 181, advance: 1308 },
      { id: 617, advance: 1130 },
    ]);
  });

  it("falls through when SF Pro Text is unavailable", () => {
    process.env.DOMOTION_HIDE_FAMILIES = "SF Pro Text,SF Pro Display,SF Pro";
    invalidateFontEnvironmentCaches();
    const stack = '"SF Pro Text", Helvetica';
    expect(resolveFontKey(stack)).toBe("helvetica");
    expect(resolveFontKeyChain(stack)).toEqual(["helvetica", "times"]);
    expect(resolveFont(stack, 400, 32, 0)?.postscriptName).toBe("Helvetica");
  });

  it("is identical in cold and warm renderer-session renders", () => {
    setRenderTextMode("paths");
    setTextRunProvenanceEnabled(true);
    invalidateFontEnvironmentCaches();
    const session = createFontRendererSession();
    const stack = '"Hiragino Kaku Gothic ProN", Helvetica';
    const cold = withFontRendererSession(session, () => renderedIdentity(stack, "🄀🄜"));
    const warm = withFontRendererSession(session, () => renderedIdentity(stack, "🄀🄜"));
    expect(warm).toEqual(cold);
    expect(cold.selected.postscriptName).toBe("HiraKakuProN-W3");
    expect(cold.glyphs).toEqual([
      { id: 8061, advance: 1000 },
      { id: 10016, advance: 1000 },
    ]);

    const sfInstalled = resolveInstalledFont("SF Pro Text");
    if (sfInstalled?.postscriptName === "SFProText-Regular") {
      const sfCold = withFontRendererSession(session, () => renderedIdentity('"SF Pro Text", Times', "Ɫⱥ"));
      const sfWarm = withFontRendererSession(session, () => renderedIdentity('"SF Pro Text", Times', "Ɫⱥ"));
      expect(sfWarm).toEqual(sfCold);
      expect(sfCold.selected.postscriptName).toBe("SFProText-Regular");
      expect(sfCold.glyphs).toEqual([
        { id: 181, advance: 1308 },
        { id: 617, advance: 1130 },
      ]);
    }
  });
});
