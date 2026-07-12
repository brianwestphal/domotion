// Minimal ambient declaration for svg2ttf — the library ships no types and no
// @types package exists. It converts an SVG-font XML string into a glyf-flavored
// TrueType font (returns a microbuffer whose `.buffer` is a Uint8Array).
declare module "svg2ttf" {
  interface Svg2TtfOptions {
    copyright?: string;
    description?: string;
    ts?: number;
    url?: string;
    version?: string;
  }
  interface Svg2TtfResult {
    buffer: Uint8Array;
  }
  function svg2ttf(svgFontString: string, options?: Svg2TtfOptions): Svg2TtfResult;
  export default svg2ttf;
}
