import type { CapturedPseudoFragmentSet } from "../capture/types.js";

type StackedPseudo = Pick<CapturedPseudoFragmentSet, "pseudo"> & {
  paint: Pick<CapturedPseudoFragmentSet["paint"], "zIndex">;
};

export type PseudoChildPaintEntry<T, P extends StackedPseudo> =
  { kind: "child"; child: T; zIndex: number } | { kind: "pseudo"; record: P; zIndex: number };

/** Merge one context's stacked children and its generated children in tree order. */
export function pseudoChildPaintOrder<T, P extends StackedPseudo>(
  children: ReadonlyArray<{ child: T; zIndex: number }>,
  pseudos: readonly P[],
): PseudoChildPaintEntry<T, P>[] {
  // Blink stable-sorts by effective z-index. Generated before/checkmark nodes
  // precede real children; after nodes follow them at the same stack level.
  const pseudoEntry = (record: P): PseudoChildPaintEntry<T, P> => ({
    kind: "pseudo",
    record,
    zIndex: record.paint.zIndex ?? 0,
  });
  const entries: PseudoChildPaintEntry<T, P>[] = [
    ...pseudos.filter((record) => record.pseudo !== "::after").map(pseudoEntry),
    ...children.map(({ child, zIndex }): PseudoChildPaintEntry<T, P> => ({ kind: "child", child, zIndex })),
    ...pseudos.filter((record) => record.pseudo === "::after").map(pseudoEntry),
  ];
  return entries.sort((left, right) => left.zIndex - right.zIndex);
}
