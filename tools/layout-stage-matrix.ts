/** Source-owned CSS text-layout states exercised by the layout-stage oracle. */
export type LayoutVerdict = "logical" | "paint" | "diagnostic";

export interface LayoutAxisValue {
  id: string;
  css?: string;
}

export interface LayoutAxis {
  id: string;
  verdict: LayoutVerdict;
  values: readonly LayoutAxisValue[];
  diagnosticFeature?: string;
}

const values = (...entries: Array<string | readonly [string, string]>): LayoutAxisValue[] =>
  entries.map((entry) => typeof entry === "string" ? { id: entry } : { id: entry[0], css: entry[1] });

/**
 * Each entry corresponds to a separate Blink inline-layout input.  Keeping the
 * inventory declarative makes a newly supported value fail the pair-coverage
 * test until the oracle names it and gives it an observable route.
 */
export const layoutAxes: readonly LayoutAxis[] = [
  { id: "direction", verdict: "logical", values: values(["ltr", "direction:ltr"], ["rtl", "direction:rtl"]) },
  { id: "unicodeBidi", verdict: "logical", values: values("normal", "embed", "isolate", "bidi-override", "isolate-override", "plaintext").map((v) => ({ ...v, css: `unicode-bidi:${v.id}` })) },
  { id: "writingMode", verdict: "logical", values: values("horizontal-tb", "vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr").map((v) => ({ ...v, css: `writing-mode:${v.id}` })) },
  { id: "textOrientation", verdict: "logical", values: values("mixed", "upright", "sideways").map((v) => ({ ...v, css: `text-orientation:${v.id}` })) },
  { id: "textCombine", verdict: "logical", values: values("none", "all").map((v) => ({ ...v, css: `text-combine-upright:${v.id}` })) },
  { id: "whiteSpace", verdict: "logical", values: values("normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces").map((v) => ({ ...v, css: `white-space:${v.id}` })) },
  { id: "overflowWrap", verdict: "logical", values: values("normal", "anywhere", "break-word").map((v) => ({ ...v, css: `overflow-wrap:${v.id}` })) },
  { id: "wordBreak", verdict: "logical", values: values("normal", "break-all", "keep-all", "auto-phrase").map((v) => ({ ...v, css: `word-break:${v.id}` })) },
  { id: "lineBreak", verdict: "logical", values: values("auto", "loose", "normal", "strict", "anywhere").map((v) => ({ ...v, css: `line-break:${v.id}` })) },
  { id: "hyphens", verdict: "logical", values: values("none", "manual", "auto").map((v) => ({ ...v, css: `hyphens:${v.id}` })) },
  { id: "tabSize", verdict: "logical", values: values(["8", "tab-size:8"], ["3", "tab-size:3"], ["24px", "tab-size:24px"]) },
  { id: "spacing", verdict: "logical", values: values(["normal", "letter-spacing:normal;word-spacing:normal"], ["positive", "letter-spacing:1.25px;word-spacing:3px"], ["negative", "letter-spacing:-0.4px;word-spacing:-1px"]) },
  { id: "rubyPosition", verdict: "logical", values: values("over", "under").map((v) => ({ ...v, css: `ruby-position:${v.id}` })) },
  { id: "rubyAlign", verdict: "logical", values: values("space-around", "start", "center", "space-between").map((v) => ({ ...v, css: `ruby-align:${v.id}` })) },
  { id: "emphasis", verdict: "paint", values: values(["none", "text-emphasis:none"], ["dot-over", "text-emphasis:filled dot;text-emphasis-position:over right"], ["sesame-under", "text-emphasis:open sesame;text-emphasis-position:under right"]) },
  { id: "justification", verdict: "diagnostic", diagnosticFeature: "text-align:justify", values: values(["start", "text-align:start"], ["center", "text-align:center"], ["justify", "text-align:justify"], ["justify-last", "text-align:justify;text-align-last:justify"]) },
  { id: "synthesis", verdict: "logical", values: values(["auto", "font-synthesis:auto"], ["none", "font-synthesis:none"], ["style-only", "font-synthesis-weight:none;font-synthesis-style:auto;font-synthesis-small-caps:none"]) },
  { id: "zoom", verdict: "logical", values: values(["1", "zoom:1"], ["0.8", "zoom:.8"], ["1.25", "zoom:1.25"]) },
  { id: "transform", verdict: "logical", values: values(["none", "transform:none"], ["translate", "transform:translate(17px,11px)"], ["scale", "transform:scale(1.125)"]) },
  { id: "fragmentation", verdict: "logical", values: values(["none", "columns:auto"], ["columns", "columns:2;column-gap:13px;height:92px"]) },
] as const;

export type LayoutAssignment = Record<string, string>;

const pairKey = (a: string, av: string, b: string, bv: string): string => `${a}=${av}\u0000${b}=${bv}`;

export function requiredPairs(axes: readonly LayoutAxis[] = layoutAxes): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++)
    for (const av of axes[i].values) for (const bv of axes[j].values)
      pairs.add(pairKey(axes[i].id, av.id, axes[j].id, bv.id));
  return pairs;
}

export function coveredPairs(rows: readonly LayoutAssignment[], axes: readonly LayoutAxis[] = layoutAxes): Set<string> {
  const pairs = new Set<string>();
  for (const row of rows) for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++)
    pairs.add(pairKey(axes[i].id, row[axes[i].id], axes[j].id, row[axes[j].id]));
  return pairs;
}

/** Deterministic greedy covering array; guarantees every value pair. */
export function generatePairwiseAssignments(axes: readonly LayoutAxis[] = layoutAxes): LayoutAssignment[] {
  if (axes.length === 0) return [];
  let rows: LayoutAssignment[] = axes.length === 1
    ? axes[0].values.map((v) => ({ [axes[0].id]: v.id }))
    : axes[0].values.flatMap((a) => axes[1].values.map((b) => ({ [axes[0].id]: a.id, [axes[1].id]: b.id })));
  for (let index = 2; index < axes.length; index++) {
    const axis = axes[index];
    const uncovered = new Set<string>();
    for (let prior = 0; prior < index; prior++) for (const pv of axes[prior].values) for (const value of axis.values)
      uncovered.add(pairKey(axes[prior].id, pv.id, axis.id, value.id));
    for (const row of rows) {
      let best = axis.values[0]; let score = -1;
      for (const value of axis.values) {
        let candidate = 0;
        for (let prior = 0; prior < index; prior++) if (uncovered.has(pairKey(axes[prior].id, row[axes[prior].id], axis.id, value.id))) candidate++;
        if (candidate > score) { best = value; score = candidate; }
      }
      row[axis.id] = best.id;
      for (let prior = 0; prior < index; prior++) uncovered.delete(pairKey(axes[prior].id, row[axes[prior].id], axis.id, best.id));
    }
    while (uncovered.size > 0) {
      const first = [...uncovered][0];
      const [left, right] = first.split("\u0000");
      const [leftAxis, leftValue] = left.split("="); const [, rightValue] = right.split("=");
      const row: LayoutAssignment = Object.fromEntries(axes.slice(0, index + 1).map((entry) => [entry.id, entry.values[0].id]));
      row[leftAxis] = leftValue; row[axis.id] = rightValue;
      rows.push(row);
      for (let prior = 0; prior < index; prior++) uncovered.delete(pairKey(axes[prior].id, row[axes[prior].id], axis.id, rightValue));
    }
  }
  return rows;
}

export function cssForAssignment(assignment: LayoutAssignment, axes: readonly LayoutAxis[] = layoutAxes): string {
  return axes.map((axis) => axis.values.find((value) => value.id === assignment[axis.id])?.css).filter(Boolean).join(";");
}
