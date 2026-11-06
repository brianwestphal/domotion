// DM-DJKYRC: the maintainer's policy for a source face whose OS/2 `fsType`
// restricts embedding is "warn, and keep embedding". The text engine reports
// the restricted faces of each generation; the root `getEmbeddedFontFaceCss()`
// turns each one into a render warning and returns the CSS unchanged. The
// engine's detection is covered in packages/text-engine (embedded-font-fstype
// tests); this file pins the root wiring onto the render-warning channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureWarning } from "../capture/types.js";

const engine = vi.hoisted(() => ({
  css: "",
  pending: [] as Array<{
    path: string;
    faceIndex: number;
    postscriptName: string | null;
    fsType: number;
    restrictions: Array<"restricted-license" | "bitmap-only">;
  }>,
}));

vi.mock("@domotion/text-engine/font-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@domotion/text-engine/font-resolution")>();
  return {
    ...actual,
    getEmbeddedFontFaceCss: () => engine.css,
    // Consuming, like the engine's: a face is reported once per generation.
    takeEmbeddedFontEmbeddingRestrictions: () => engine.pending.splice(0),
  };
});

const {
  describeEmbeddingRestriction,
  EMBEDDED_FONT_FSTYPE_WARNING,
  getEmbeddedFontFaceCss,
  reportEmbeddedFontEmbeddingRestrictions,
} = await import("./embedded-font-css.js");
const { withRenderWarningSink } = await import("./render-warn.js");

describe("root getEmbeddedFontFaceCss embedding-restriction warnings", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    engine.css = '@font-face { font-family: "dmf0"; src: url("data:font/ttf;base64,AAAA"); }';
    engine.pending = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it("warns once per restricted face through the active sink and leaves the CSS unchanged", () => {
    engine.pending = [
      {
        path: "/fonts/Restricted.ttf",
        faceIndex: 0,
        postscriptName: "Restricted-Regular",
        fsType: 0x0002,
        restrictions: ["restricted-license"],
      },
      {
        path: "/fonts/Collection.ttc",
        faceIndex: 3,
        postscriptName: null,
        fsType: 0x0202,
        restrictions: ["restricted-license", "bitmap-only"],
      },
    ];
    const sink: CaptureWarning[] = [];
    const css = withRenderWarningSink(sink, () => [getEmbeddedFontFaceCss(), getEmbeddedFontFaceCss()]);
    expect(css).toEqual([engine.css, engine.css]);
    expect(sink).toEqual([
      {
        selector: "",
        feature: EMBEDDED_FONT_FSTYPE_WARNING,
        detail:
          'embedded font "Restricted-Regular" (/fonts/Restricted.ttf#0) declares OS/2 fsType 0x0002 ' +
          "(Restricted License embedding); Domotion embedded a subset of it anyway. Check the font's license, " +
          "or render with --text-mode paths to emit glyph outlines instead of an embedded font.",
      },
      expect.objectContaining({
        feature: EMBEDDED_FONT_FSTYPE_WARNING,
        detail: expect.stringContaining(
          '"Collection.ttc" (/fonts/Collection.ttc#3) declares OS/2 fsType 0x0202 ' +
            "(Restricted License embedding, bitmap embedding only)",
        ),
      }),
    ]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("reports a drained restriction to an explicit sink over the active one, and returns it", () => {
    // Studio's interactive compiler reads the engine's CSS artifacts directly and
    // drains the restrictions through this helper (DM-J4WX7N).
    engine.pending = [
      { path: "/fonts/R.ttf", faceIndex: 0, postscriptName: "R", fsType: 0x0200, restrictions: ["bitmap-only"] },
    ];
    const active: CaptureWarning[] = [];
    const explicit: CaptureWarning[] = [];
    const reported = withRenderWarningSink(active, () => reportEmbeddedFontEmbeddingRestrictions(explicit));
    expect(active).toEqual([]);
    expect(explicit).toEqual(reported);
    expect(reported).toEqual([
      expect.objectContaining({
        selector: "",
        feature: EMBEDDED_FONT_FSTYPE_WARNING,
        detail: expect.stringContaining("bitmap embedding only"),
      }),
    ]);
    // consumed: a second drain reports nothing
    expect(reportEmbeddedFontEmbeddingRestrictions(explicit)).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when no embedded face is restricted", () => {
    const sink: CaptureWarning[] = [];
    expect(withRenderWarningSink(sink, () => getEmbeddedFontFaceCss())).toBe(engine.css);
    expect(sink).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("names a face by its file name when the source has no PostScript name, on either separator", () => {
    expect(
      describeEmbeddingRestriction({
        path: "C:\\Windows\\Fonts\\restricted.ttf",
        faceIndex: 0,
        postscriptName: null,
        fsType: 0x0200,
        restrictions: ["bitmap-only"],
      }),
    ).toContain('embedded font "restricted.ttf" (C:\\Windows\\Fonts\\restricted.ttf#0) declares OS/2 fsType 0x0200');
  });
});

describe("embedded-font CSS ownership", () => {
  it("routes every production render through the warning-reporting wrapper", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcRoot = fileURLToPath(new URL("../", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith("embedded-font-css.ts")) {
          const source = readFileSync(path, "utf8");
          for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*font-resolution(?:\.js)?)["']/g)) {
            if (/\bgetEmbeddedFontFaceCss\b/.test(m[1])) offenders.push(path.slice(srcRoot.length));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
