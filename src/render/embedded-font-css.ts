import {
  getEmbeddedFontFaceCss as buildEmbeddedFontFaceCss,
  type EmbeddedFontEmbeddingRestriction,
  takeEmbeddedFontEmbeddingRestrictions,
} from "./font-resolution.js";
import { renderWarn } from "./render-warn.js";

/** Render-warning feature id for a restricted-embedding source face. */
export const EMBEDDED_FONT_FSTYPE_WARNING = "embedded-font-fstype";

const RESTRICTION_LABEL: Record<EmbeddedFontEmbeddingRestriction["restrictions"][number], string> = {
  "restricted-license": "Restricted License embedding",
  "bitmap-only": "bitmap embedding only",
};

/** The warning text for one restricted source face. */
export function describeEmbeddingRestriction(r: EmbeddedFontEmbeddingRestriction): string {
  const face = r.postscriptName ?? r.path.split(/[\\/]/).pop() ?? r.path;
  const fsType = `0x${r.fsType.toString(16).padStart(4, "0")}`;
  const kinds = r.restrictions.map((kind) => RESTRICTION_LABEL[kind]).join(", ");
  return (
    `embedded font "${face}" (${r.path}#${r.faceIndex}) declares OS/2 fsType ${fsType} (${kinds}); ` +
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
  for (const restriction of takeEmbeddedFontEmbeddingRestrictions()) {
    renderWarn(EMBEDDED_FONT_FSTYPE_WARNING, describeEmbeddingRestriction(restriction));
  }
  return css;
}
