import { describe, expect, it } from "vitest";
import {
  ensureGlyphDef,
  getGlyphDefs,
  getRenderTextMode,
  restoreGeneration,
  setRenderTextMode,
  snapshotFontRegistrations,
  snapshotGeneration,
} from "./font-resolution.js";
import { snapshotBaselineSnapSuppression } from "./text-to-path.js";
import {
  clearTextEngineFonts,
  createTextEngineSession,
  registerTextEngineLocalFontAlias,
  withTextEngineDocument,
} from "./text-engine.js";

const addTestGlyph = (glyphId: number): void => {
  ensureGlyphDef("test", 400, 16, 0, glyphId, [
    { command: "moveTo", args: [0, 0] },
    { command: "lineTo", args: [glyphId + 1, 0] },
    { command: "closePath", args: [] },
  ]);
};

describe("text-engine facade", () => {
  it("keeps an implicit document's generation available to ambient compatibility callers", () => {
    const outer = snapshotGeneration();
    try {
      withTextEngineDocument({ generation: "reset", renderTextMode: "paths" }, () => addTestGlyph(1));
      expect(getGlyphDefs()).toContain('id="g0"');

      withTextEngineDocument({ generation: "continue", renderTextMode: "paths" }, () => addTestGlyph(2));
      expect(getGlyphDefs()).toContain('id="g0"');
      expect(getGlyphDefs()).toContain('id="g1"');
    } finally {
      restoreGeneration(outer);
    }
  });

  it("isolates generated artifacts between sessions and continues one session explicitly", () => {
    const first = createTextEngineSession();
    const second = createTextEngineSession();

    const initial = withTextEngineDocument({ session: first, generation: "reset", renderTextMode: "paths" }, () => {
      addTestGlyph(1);
      return "first";
    });
    expect(initial.value).toBe("first");
    expect(initial.artifacts.glyphDefs).toContain('id="g0"');

    const isolated = withTextEngineDocument(
      { session: second, generation: "reset", renderTextMode: "paths" },
      () => undefined,
    );
    expect(isolated.artifacts.glyphDefs).toBe("");

    const continued = withTextEngineDocument(
      { session: first, generation: "continue", renderTextMode: "paths" },
      () => {
        addTestGlyph(2);
      },
    );
    expect(continued.artifacts.glyphDefs).toContain('id="g0"');
    expect(continued.artifacts.glyphDefs).toContain('id="g1"');
  });

  it("scopes render mode and restores it after throws", () => {
    const session = createTextEngineSession();
    setRenderTextMode("embedded-font");
    expect(() =>
      withTextEngineDocument({ session, renderTextMode: "paths" }, (document) => {
        expect(document.renderTextMode).toBe("paths");
        expect(getRenderTextMode()).toBe("paths");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(getRenderTextMode()).toBe("embedded-font");
  });

  it("restores document-owned baseline policy after an exceptional exit", () => {
    const session = createTextEngineSession();
    const before = snapshotBaselineSnapSuppression();
    expect(() =>
      withTextEngineDocument({ session }, (document) => {
        document.enterBaselineSnappingSuppressed();
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(snapshotBaselineSnapSuppression()).toBe(before);
  });

  it("shares an active document with nested adapters and rejects conflicting ownership", () => {
    const outer = createTextEngineSession();
    const other = createTextEngineSession();
    withTextEngineDocument({ session: outer }, (document) => {
      const nested = withTextEngineDocument({}, (inner) => inner);
      expect(nested.value).toBe(document);
      expect(() => withTextEngineDocument({ session: other }, () => undefined)).toThrow(/switch text-engine sessions/);
      expect(() => withTextEngineDocument({ generation: "reset" }, () => undefined)).toThrow(/reset a nested/);
    });
  });

  it("rejects Promise-like document callbacks", () => {
    const session = createTextEngineSession();
    expect(() =>
      withTextEngineDocument({ session }, (() => Promise.resolve("escaped")) as unknown as () => string),
    ).toThrow(/must be synchronous/);
  });

  it("keeps registered font aliases session-owned", () => {
    const outer = snapshotFontRegistrations();
    const first = createTextEngineSession();
    const second = createTextEngineSession();
    registerTextEngineLocalFontAlias(first, "Session Face", "helvetica");

    const firstFonts = withTextEngineDocument({ session: first }, () => snapshotFontRegistrations());
    const secondFonts = withTextEngineDocument({ session: second }, () => snapshotFontRegistrations());
    expect(firstFonts.value.localAliases).toHaveLength(1);
    expect(secondFonts.value.localAliases).toHaveLength(0);
    expect(snapshotFontRegistrations()).toEqual(outer);

    clearTextEngineFonts(first);
    const cleared = withTextEngineDocument({ session: first }, () => snapshotFontRegistrations());
    expect(cleared.value.localAliases).toHaveLength(0);
  });
});
