import {
  getEmbeddedFontFaceCss as buildEmbeddedFontFaceCss,
  type EmbeddedFontEmbeddingRestriction,
  takeEmbeddedFontEmbeddingRestrictions,
} from "./font-resolution.js";
import type { CaptureWarning } from "../capture/types.js";
import { renderWarn } from "./render-warn.js";

/** Render-warning feature id for a restricted-embedding source face. */
export const EMBEDDED_FONT_FSTYPE_WARNING = "embedded-font-fstype";

const RESTRICTION_LABEL: Record<EmbeddedFontEmbeddingRestriction["restrictions"][number], string> = {
  "restricted-license": "Restricted License embedding",
  "bitmap-only": "bitmap embedding only",
};

/** The warning text for one restricted source face. */
export function describeEmbeddingRestriction(r: EmbeddedFontEmbeddingRestriction): string {
  const fsType = `0x${r.fsType.toString(16).padStart(4, "0")}`;
  const kinds = r.restrictions.map((kind) => RESTRICTION_LABEL[kind]).join(", ");
  const subject =
    r.source === "webfont"
      ? `embedded webfont "${r.postscriptName ?? r.familyName ?? "unnamed"}"` +
        (r.familyName != null && r.postscriptName != null ? ` (font family "${r.familyName}")` : "")
      : `embedded font "${r.postscriptName ?? r.path.split(/[\\/]/).pop() ?? r.path}" (${r.path}#${r.faceIndex})`;
  return (
    `${subject} declares OS/2 fsType ${fsType} (${kinds}); ` +
    `Domotion embedded a subset of it anyway. Check the font's license, or render with --text-mode paths ` +
    `to emit glyph outlines instead of an embedded font.`
  );
}

/**
 * Emit one `@font-face` rule per font the embedded-font path registered during
 * this render pass (the text-engine build), and report each source face whose
 * OS/2 `fsType` restricts embedding as a render warning.
 *
 * The policy for such a face is warn and keep embedding, so the returned CSS is
 * exactly the engine's. Chromium does not read `fsType` for webfonts either
 * (Blink's font code has no use of it at 7d859f27; OTS only normalizes the
 * bits). The engine reports each face once per generation, however many times
 * the generation builds its CSS, so a multi-frame render warns once per face.
 */
export function getEmbeddedFontFaceCss(): string {
  const css = buildEmbeddedFontFaceCss();
  reportEmbeddedFontEmbeddingRestrictions();
  return css;
}

/**
 * Drain the active text-engine generation's not-yet-reported restricted source
 * faces and report each as an `embedded-font-fstype` render warning. Callers
 * that read the engine's `artifacts().embeddedFontFaceCss` directly (Studio's
 * interactive compiler) call this instead of the CSS wrapper above. Each
 * warning goes to `sink` when given, else to the active render-warning sink
 * or the capture-warnings global, and is also returned.
 */
export function reportEmbeddedFontEmbeddingRestrictions(sink?: CaptureWarning[]): CaptureWarning[] {
  const reported: CaptureWarning[] = [];
  for (const restriction of takeEmbeddedFontEmbeddingRestrictions()) {
    const detail = describeEmbeddingRestriction(restriction);
    renderWarn(EMBEDDED_FONT_FSTYPE_WARNING, detail, "", sink);
    reported.push({ selector: "", feature: EMBEDDED_FONT_FSTYPE_WARNING, detail });
  }
  return reported;
}
