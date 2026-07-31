/**
 * `unicode-properties` ships no types. Only the members we use are declared —
 * the same table fontkit's shaper consults for script detection, which is why
 * segmentation built on it agrees with shaping by construction.
 */
declare module "unicode-properties" {
  /** Unicode Script property value, e.g. "Latin", "Arabic", "Common". */
  export function getScript(codePoint: number): string;
  export function getCategory(codePoint: number): string;
  export function getCombiningClass(codePoint: number): string;
  export function getEastAsianWidth(codePoint: number): string;
  export function getNumericValue(codePoint: number): number | null;
  export function isAlphabetic(codePoint: number): boolean;
  export function isDigit(codePoint: number): boolean;
  export function isMark(codePoint: number): boolean;
  export function isWhiteSpace(codePoint: number): boolean;
}
