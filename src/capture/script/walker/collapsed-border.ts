// Mirrors Blink table_borders.cc:IsSourceMoreSpecificThanEdge. Candidates
// must be supplied in Blink merge order: cells, rows, row groups, columns,
// column groups, then table. Exact ties retain the first candidate.
export interface CollapsedBorderCandidate {
  w: number;
  style: string;
  color?: string;
  order?: number;
  [key: string]: unknown;
}

export const COLLAPSED_BORDER_STYLE_RANK: Record<string, number> = {
  none: 0, inset: 2, groove: 3, outset: 4, ridge: 5,
  dotted: 6, dashed: 7, solid: 8, double: 9,
};

export function resolveCollapsedBorderWinner<T extends CollapsedBorderCandidate>(candidates: Array<T | null>): T | { hidden: true } | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (candidate.style === "hidden") return { hidden: true };
    if (candidate.style === "none" || candidate.w === 0) continue;
    if (best == null || candidate.w > best.w) { best = candidate; continue; }
    if (candidate.w < best.w) continue;
    if ((COLLAPSED_BORDER_STYLE_RANK[candidate.style] ?? 0) > (COLLAPSED_BORDER_STYLE_RANK[best.style] ?? 0)) best = candidate;
  }
  return best;
}
