declare module "unicode-properties" {
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
