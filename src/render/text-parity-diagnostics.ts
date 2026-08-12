export interface UnsupportedTextDiagnostic {
  verdict: "explicit-unsupported";
  feature: string;
  message: string;
  remediation: string;
  fallback: "rasterize-text";
}

/** Enumerated, detectable text/layout inputs that cannot claim logical parity. */
export function unsupportedTextParityDiagnostic(style: {
  textOrientation?: string; textCombineUpright?: string; textWrapMode?: string;
}): UnsupportedTextDiagnostic | null {
  if (style.textOrientation === "sideways") return {
    verdict: "explicit-unsupported", feature: "text-orientation: sideways",
    message: "Sideways vertical glyph orientation is not represented by the logical SVG text pipeline.",
    remediation: "Remove `text-orientation: sideways` or enable raster text fallback for this element.", fallback: "rasterize-text",
  };
  if (style.textCombineUpright != null && style.textCombineUpright !== "none") return {
    verdict: "explicit-unsupported", feature: `text-combine-upright: ${style.textCombineUpright}`,
    message: "Multi-character tate-chu-yoko layout cannot be reconstructed from independent glyph origins.",
    remediation: "Use `text-combine-upright: none` or enable raster text fallback for this element.", fallback: "rasterize-text",
  };
  if (style.textWrapMode === "nowrap") return null; // captured line geometry is exact
  return null;
}
