import type { CapturedElement, CapturedStyles, TextSegment } from "../capture/types.js";

/**
 * A captured element as a focused unit test writes it: only the fields the
 * code under test reads. A real capture carries the full computed-style
 * record (dozens of required `CapturedStyles` fields), which a fixture for one
 * gradient layer or one text segment has no reason to spell out.
 */
export type PartialCapturedElement = DeepPartial<CapturedElement>;

/** Every field optional, recursively through nested records and arrays. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends (infer U)[]
    ? DeepPartial<U>[]
    : T extends readonly (infer U)[]
      ? readonly DeepPartial<U>[]
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T;

/**
 * Treat a partial fixture as a captured tree. The field names are still
 * checked against the capture schema; only the required-but-unread fields are
 * waived, so a typo or a removed field still fails to compile.
 */
export function capturedTree(nodes: PartialCapturedElement[]): CapturedElement[] {
  return nodes as CapturedElement[];
}

/** {@link capturedTree} for a single element. */
export function capturedElement(node: PartialCapturedElement): CapturedElement {
  return node as CapturedElement;
}

/** {@link capturedTree} for a style record alone. */
export function capturedStyles(styles: DeepPartial<CapturedStyles>): CapturedStyles {
  return styles as CapturedStyles;
}

/** {@link capturedTree} for a single text segment. */
export function capturedSegment(segment: DeepPartial<TextSegment>): TextSegment {
  return segment as TextSegment;
}
