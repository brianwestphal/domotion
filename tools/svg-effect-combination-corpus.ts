/**
 * Deterministic pairwise SVG paint-effect corpus (DM-2358).
 *
 * The values are class inputs owned by Blink/native SVG. Domotion does not
 * reproduce their geometry: it makes the computed cascade self-contained and
 * delegates the resulting SVG subtree to the output browser.
 */

export const SVG_EFFECT_SOURCE_REVISION = "chromium:7d859f271cbda744098ac69f44978d4edfa62be3";

export const SVG_EFFECT_SOURCE_DECISIONS = {
  gradientUnits: "third_party/blink/renderer/core/layout/svg/layout_svg_resource_gradient.cc:100-141",
  gradientInterpolation: "third_party/blink/renderer/core/layout/svg/layout_svg_resource_gradient.cc:129-138",
  effectReferenceBox: "third_party/blink/renderer/core/layout/svg/svg_resources.cc:53-102",
  clipPathUnits: "third_party/blink/renderer/core/layout/svg/layout_svg_resource_clipper.cc:229-248",
  maskUnits: "third_party/blink/renderer/core/layout/svg/layout_svg_resource_masker.cc:73-110",
  cssMaskLayers: "third_party/blink/renderer/core/paint/svg_mask_painter.cc:115-190",
  filterReferenceBox: "third_party/blink/renderer/core/layout/svg/svg_resources.cc:357-421",
  clipMaskPaintProperties: "third_party/blink/renderer/core/layout/svg/layout_svg_model_object.cc:145-177",
  markers: "third_party/blink/renderer/core/layout/svg/layout_svg_resource_marker.cc:120-168",
  nonScalingStroke: "third_party/blink/renderer/core/layout/svg/layout_svg_shape.cc:468-508",
  transformReferenceBox: "third_party/blink/renderer/core/layout/svg/transform_helper.cc:64-176",
} as const;

export const SVG_EFFECT_DIMENSIONS = [
  { name: "shape", values: ["rect", "circle", "path"] },
  { name: "gradientKind", values: ["linear", "radial"] },
  { name: "gradientUnits", values: ["objectBoundingBox", "userSpaceOnUse"] },
  { name: "gradientInterpolation", values: ["sRGB", "linearRGB"] },
  { name: "filterRoute", values: ["none", "url"] },
  { name: "clipRoute", values: ["basic-circle", "basic-inset", "url"] },
  { name: "clipPathUnits", values: ["objectBoundingBox", "userSpaceOnUse"] },
  { name: "referenceBox", values: ["fill-box", "stroke-box", "view-box"] },
  { name: "viewport", values: ["root", "nested"] },
  { name: "markers", values: ["none", "all"] },
  { name: "vectorEffect", values: ["none", "non-scaling-stroke"] },
  { name: "transform", values: ["none", "affine", "projective"] },
  { name: "maskUnits", values: ["objectBoundingBox", "userSpaceOnUse"] },
  { name: "maskContentUnits", values: ["objectBoundingBox", "userSpaceOnUse"] },
  { name: "maskOrigin", values: ["fill-box", "stroke-box", "view-box"] },
  { name: "maskClip", values: ["fill-box", "stroke-box", "view-box"] },
  { name: "maskSize", values: ["auto", "50% 80%", "cover"] },
  { name: "maskRepeat", values: ["no-repeat", "repeat-x", "space"] },
  { name: "maskComposite", values: ["add", "subtract", "intersect", "exclude"] },
] as const;

export type SvgEffectDimension = typeof SVG_EFFECT_DIMENSIONS[number];
export type SvgEffectAxis = SvgEffectDimension["name"];
export type SvgEffectValues = Record<SvgEffectAxis, string>;

export interface SvgEffectCombinationCase {
  id: string;
  ordinal: number;
  values: SvgEffectValues;
  sourceDecisions: Array<keyof typeof SVG_EFFECT_SOURCE_DECISIONS>;
}

export interface SvgEffectPairCoverage {
  expectedPairs: number;
  coveredPairs: number;
  missingPairs: string[];
}

/** Source-selected triples, not an assertion of exhaustive CSS 3-wise coverage. */
export const SVG_EFFECT_TARGETED_TRIPLES: readonly (readonly [SvgEffectAxis, SvgEffectAxis, SvgEffectAxis])[] = [
  ["maskUnits", "clipPathUnits", "referenceBox"],
  ["filterRoute", "clipRoute", "maskUnits"],
  ["gradientUnits", "gradientInterpolation", "filterRoute"],
  ["markers", "vectorEffect", "transform"],
  ["transform", "referenceBox", "clipRoute"],
  ["viewport", "transform", "filterRoute"],
] as const;

export interface SvgEffectHigherOrderCoverage {
  expectedTargetedTriples: number;
  coveredTargetedTriples: number;
  missingTargetedTriples: string[];
}

const pairKey = (leftIndex: number, leftValue: string, rightIndex: number, rightValue: string): string =>
  `${leftIndex}:${leftValue}|${rightIndex}:${rightValue}`;

function allPairKeys(): string[] {
  const keys: string[] = [];
  for (let left = 0; left < SVG_EFFECT_DIMENSIONS.length; left++) {
    for (let right = left + 1; right < SVG_EFFECT_DIMENSIONS.length; right++) {
      for (const leftValue of SVG_EFFECT_DIMENSIONS[left].values) {
        for (const rightValue of SVG_EFFECT_DIMENSIONS[right].values) {
          keys.push(pairKey(left, leftValue, right, rightValue));
        }
      }
    }
  }
  return keys;
}

const dimensionIndex = new Map<SvgEffectAxis, number>(SVG_EFFECT_DIMENSIONS.map((axis, index) => [axis.name, index]));

function tripleKey(indices: readonly number[], values: readonly string[]): string {
  return indices.map((index, offset) => `${index}:${values[offset]}`).join("|");
}

function allTargetedTripleKeys(): string[] {
  const keys: string[] = [];
  for (const names of SVG_EFFECT_TARGETED_TRIPLES) {
    const indices = names.map((name) => dimensionIndex.get(name)!);
    for (const a of SVG_EFFECT_DIMENSIONS[indices[0]].values) {
      for (const b of SVG_EFFECT_DIMENSIONS[indices[1]].values) {
        for (const c of SVG_EFFECT_DIMENSIONS[indices[2]].values) keys.push(tripleKey(indices, [a, b, c]));
      }
    }
  }
  return keys;
}

/**
 * Greedy, deterministic all-pairs construction. Every iteration starts with
 * the lexicographically first uncovered pair, then chooses each remaining
 * value by the number of uncovered pairs it closes against assigned axes.
 */
export function generateSvgEffectCombinations(): SvgEffectCombinationCase[] {
  const uncovered = new Set(allPairKeys());
  const uncoveredTriples = new Set(allTargetedTripleKeys());
  const rows: string[][] = [];
  while (uncovered.size > 0 || uncoveredTriples.size > 0) {
    const row: Array<string | null> = Array(SVG_EFFECT_DIMENSIONS.length).fill(null);
    const seed = [...uncoveredTriples].sort()[0] ?? [...uncovered].sort()[0];
    for (const part of seed.split("|")) {
      const separator = part.indexOf(":");
      row[Number(part.slice(0, separator))] = part.slice(separator + 1);
    }

    for (let axis = 0; axis < SVG_EFFECT_DIMENSIONS.length; axis++) {
      if (row[axis] != null) continue;
      let best = SVG_EFFECT_DIMENSIONS[axis].values[0] as string;
      let bestScore = -1;
      for (const value of SVG_EFFECT_DIMENSIONS[axis].values) {
        let score = 0;
        for (let other = 0; other < row.length; other++) {
          if (row[other] == null) continue;
          const left = Math.min(axis, other);
          const right = Math.max(axis, other);
          const key = axis < other
            ? pairKey(left, value, right, row[other]!)
            : pairKey(left, row[other]!, right, value);
          if (uncovered.has(key)) score++;
        }
        const candidate = [...row];
        candidate[axis] = value;
        for (const names of SVG_EFFECT_TARGETED_TRIPLES) {
          const indices = names.map((name) => dimensionIndex.get(name)!);
          if (indices.every((index) => candidate[index] != null)
              && uncoveredTriples.has(tripleKey(indices, indices.map((index) => candidate[index]!)))) score += 4;
        }
        if (score > bestScore) {
          best = value;
          bestScore = score;
        }
      }
      row[axis] = best;
    }
    for (const names of SVG_EFFECT_TARGETED_TRIPLES) {
      const indices = names.map((name) => dimensionIndex.get(name)!);
      uncoveredTriples.delete(tripleKey(indices, indices.map((index) => row[index]!)));
    }

    for (let left = 0; left < row.length; left++) {
      for (let right = left + 1; right < row.length; right++) {
        uncovered.delete(pairKey(left, row[left]!, right, row[right]!));
      }
    }
    rows.push(row as string[]);
  }

  return rows.map((row, ordinal) => ({
    id: `svg-effect-${String(ordinal + 1).padStart(2, "0")}`,
    ordinal,
    values: Object.fromEntries(SVG_EFFECT_DIMENSIONS.map((dimension, axis) => [dimension.name, row[axis]])) as SvgEffectValues,
    sourceDecisions: [
      "gradientUnits",
      "gradientInterpolation",
      "effectReferenceBox",
      "clipPathUnits",
      "maskUnits",
      "cssMaskLayers",
      "filterReferenceBox",
      "clipMaskPaintProperties",
      "markers",
      "nonScalingStroke",
      "transformReferenceBox",
    ],
  }));
}

export function svgEffectHigherOrderCoverage(cases: readonly SvgEffectCombinationCase[]): SvgEffectHigherOrderCoverage {
  const expected = new Set(allTargetedTripleKeys());
  const covered = new Set<string>();
  for (const test of cases) {
    for (const names of SVG_EFFECT_TARGETED_TRIPLES) {
      const indices = names.map((name) => dimensionIndex.get(name)!);
      covered.add(tripleKey(indices, names.map((name) => test.values[name])));
    }
  }
  const missingTargetedTriples = [...expected].filter((key) => !covered.has(key)).sort();
  return {
    expectedTargetedTriples: expected.size,
    coveredTargetedTriples: expected.size - missingTargetedTriples.length,
    missingTargetedTriples,
  };
}

export function svgEffectPairCoverage(cases: readonly SvgEffectCombinationCase[]): SvgEffectPairCoverage {
  const expected = new Set(allPairKeys());
  const covered = new Set<string>();
  for (const test of cases) {
    for (let left = 0; left < SVG_EFFECT_DIMENSIONS.length; left++) {
      for (let right = left + 1; right < SVG_EFFECT_DIMENSIONS.length; right++) {
        covered.add(pairKey(
          left,
          test.values[SVG_EFFECT_DIMENSIONS[left].name],
          right,
          test.values[SVG_EFFECT_DIMENSIONS[right].name],
        ));
      }
    }
  }
  const missingPairs = [...expected].filter((key) => !covered.has(key)).sort();
  return { expectedPairs: expected.size, coveredPairs: expected.size - missingPairs.length, missingPairs };
}

export const SVG_EFFECT_CASES = generateSvgEffectCombinations();
export const SVG_EFFECT_TILE = { width: 180, height: 150, columns: 4 } as const;
export const SVG_EFFECT_VIEWPORT = {
  width: SVG_EFFECT_TILE.width * SVG_EFFECT_TILE.columns,
  height: SVG_EFFECT_TILE.height * Math.ceil(SVG_EFFECT_CASES.length / SVG_EFFECT_TILE.columns),
} as const;

function shapeMarkup(test: SvgEffectCombinationCase): string {
  if (test.values.shape === "circle") return `<circle class="paint-${test.ordinal}" cx="78" cy="61" r="39"/>`;
  if (test.values.shape === "path") return `<path class="paint-${test.ordinal}" d="M20 99L74 17L137 91L45 76Z"/>`;
  return `<rect class="paint-${test.ordinal}" x="29" y="24" width="96" height="72" rx="11"/>`;
}

function gradientMarkup(test: SvgEffectCombinationCase): string {
  const units = test.values.gradientUnits;
  const coords = units === "objectBoundingBox"
    ? test.values.gradientKind === "linear" ? `x1="0" y1="0" x2="1" y2="1"` : `cx=".48" cy=".44" r=".7" fx=".31" fy=".29"`
    : test.values.gradientKind === "linear" ? `x1="5" y1="8" x2="148" y2="106"` : `cx="76" cy="54" r="74" fx="43" fy="31"`;
  const tag = test.values.gradientKind === "linear" ? "linearGradient" : "radialGradient";
  return `<${tag} id="gradient-${test.ordinal}" class="gradient-${test.ordinal}" gradientUnits="${units}" ${coords} color-interpolation="sRGB"><stop offset="0" stop-color="#f97316"/><stop offset=".48" stop-color="#22c55e"/><stop offset="1" stop-color="#2563eb"/></${tag}>`;
}

function clipMarkup(test: SvgEffectCombinationCase): string {
  const bbox = test.values.clipPathUnits === "objectBoundingBox";
  const geometry = bbox
    ? `<path d="M.05 .12H.92L.72 .92H.17Z"/>`
    : `<path d="M8 13H148L116 106H27Z"/>`;
  return `<clipPath id="clip-${test.ordinal}" clipPathUnits="${test.values.clipPathUnits}">${geometry}</clipPath>`;
}

function maskMarkup(test: SvgEffectCombinationCase): string {
  const bboxRegion = test.values.maskUnits === "objectBoundingBox";
  const bboxContent = test.values.maskContentUnits === "objectBoundingBox";
  const region = bboxRegion ? `x="-.08" y="-.08" width="1.16" height="1.16"` : `x="0" y="0" width="160" height="120"`;
  const content = bboxContent
    ? `<rect width="1" height="1" fill="white"/><circle cx=".72" cy=".28" r=".19" fill="black"/>`
    : `<rect width="160" height="120" fill="white"/><circle cx="114" cy="34" r="23" fill="black"/>`;
  return `<mask id="mask-${test.ordinal}" maskUnits="${test.values.maskUnits}" maskContentUnits="${test.values.maskContentUnits}" ${region} mask-type="alpha">${content}</mask>`;
}

function markerMarkup(test: SvgEffectCombinationCase): string {
  return `<marker id="marker-${test.ordinal}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0 0L8 4L0 8Z" fill="#7c3aed"/></marker>`;
}

function filterMarkup(test: SvgEffectCombinationCase): string {
  return `<filter id="filter-${test.ordinal}" filterUnits="objectBoundingBox" x="-.15" y="-.15" width="1.3" height="1.3"><feGaussianBlur stdDeviation="1.1"/><feColorMatrix values="1 0 0 0 0 0 .92 0 0 0 0 0 .84 0 0 0 0 0 1 0"/></filter>`;
}

function cssFor(test: SvgEffectCombinationCase): string {
  const clip = test.values.clipRoute === "url"
    ? `url("#clip-${test.ordinal}")`
    : `${test.values.clipRoute === "basic-circle" ? "circle(43% at 47% 52%)" : "inset(8% 13% 17% 5% round 8px)"} ${test.values.referenceBox}`;
  const transform = test.values.transform === "affine"
    ? `transform:translate(7px,3px) rotate(11deg) scale(.92,1.06);transform-box:fill-box;transform-origin:50% 50%;`
    : "";
  const filter = test.values.filterRoute === "url" ? `filter:url("#filter-${test.ordinal}");` : "filter:none;";
  const marker = test.values.markers === "all"
    ? `marker-start:url("#marker-${test.ordinal}");marker-mid:url("#marker-${test.ordinal}");marker-end:url("#marker-${test.ordinal}");`
    : `marker-start:none;marker-mid:none;marker-end:none;`;
  return `
    .gradient-${test.ordinal}{color-interpolation:${test.values.gradientInterpolation}}
    .paint-${test.ordinal}{fill:url("#gradient-${test.ordinal}");stroke:#172554;stroke-width:8;clip-path:${clip};mask:url("#mask-${test.ordinal}");${filter}vector-effect:${test.values.vectorEffect};${transform}}
    .marker-line-${test.ordinal}{fill:none;stroke:#be123c;stroke-width:3;${marker}vector-effect:${test.values.vectorEffect};${transform}}
    .css-mask-${test.ordinal}{fill:#0891b2;stroke:#0f172a;stroke-width:6;mask-image:linear-gradient(90deg,black 0 61%,transparent 61%),linear-gradient(black,transparent);mask-origin:${test.values.maskOrigin},${test.values.maskClip};mask-clip:${test.values.maskClip},${test.values.maskOrigin};mask-size:${test.values.maskSize},45% 65%;mask-repeat:${test.values.maskRepeat},no-repeat;mask-composite:${test.values.maskComposite},add;mask-mode:alpha,alpha}
  `;
}

function tileMarkup(test: SvgEffectCombinationCase): string {
  const x = (test.ordinal % SVG_EFFECT_TILE.columns) * SVG_EFFECT_TILE.width;
  const y = Math.floor(test.ordinal / SVG_EFFECT_TILE.columns) * SVG_EFFECT_TILE.height;
  const content = `${shapeMarkup(test)}<polyline class="marker-line-${test.ordinal}" points="26,116 77,96 130,118"/><rect class="css-mask-${test.ordinal}" x="137" y="18" width="30" height="104" rx="5"/>`;
  const owner = test.values.viewport === "nested"
    ? `<svg x="7" y="6" width="164" height="136" viewBox="0 0 176 146" preserveAspectRatio="xMidYMid meet" overflow="visible">${content}</svg>`
    : content;
  const projective = test.values.transform === "projective"
    ? ";transform:perspective(520px) rotateY(9deg);transform-origin:50% 50%"
    : "";
  return `<svg data-effect-case="${test.id}" style="position:absolute;left:${x}px;top:${y}px${projective}" width="180" height="150" viewBox="0 0 180 150"><defs>${gradientMarkup(test)}${clipMarkup(test)}${maskMarkup(test)}${markerMarkup(test)}${filterMarkup(test)}</defs>${owner}</svg>`;
}

export function buildSvgEffectCombinationHtml(cases: readonly SvgEffectCombinationCase[] = SVG_EFFECT_CASES): string {
  const css = cases.map(cssFor).join("\n");
  const tiles = cases.map(tileMarkup).join("\n");
  return `<!doctype html><style>html,body{margin:0;background:white}#stage{position:relative;width:${SVG_EFFECT_VIEWPORT.width}px;height:${SVG_EFFECT_VIEWPORT.height}px;background:white;overflow:hidden}${css}</style><div id="stage">${tiles}</div>`;
}

export function validateSvgEffectCombinationCorpus(cases: readonly SvgEffectCombinationCase[] = SVG_EFFECT_CASES): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const test of cases) {
    if (ids.has(test.id)) errors.push(`duplicate case id: ${test.id}`);
    ids.add(test.id);
    for (const dimension of SVG_EFFECT_DIMENSIONS) {
      if (!(dimension.values as readonly string[]).includes(test.values[dimension.name])) {
        errors.push(`${test.id}: invalid ${dimension.name}=${test.values[dimension.name]}`);
      }
    }
    for (const source of test.sourceDecisions) {
      if (SVG_EFFECT_SOURCE_DECISIONS[source] == null) errors.push(`${test.id}: missing source decision ${source}`);
    }
  }
  const coverage = svgEffectPairCoverage(cases);
  if (coverage.missingPairs.length > 0) errors.push(`missing ${coverage.missingPairs.length}/${coverage.expectedPairs} pairwise transitions`);
  const higherOrder = svgEffectHigherOrderCoverage(cases);
  if (higherOrder.missingTargetedTriples.length > 0) errors.push(`missing ${higherOrder.missingTargetedTriples.length}/${higherOrder.expectedTargetedTriples} source-selected triples`);
  const html = buildSvgEffectCombinationHtml(cases);
  if (/clip-path\s*:\s*url\([^;]+\)\s+(?:fill|stroke|view)-box/.test(html)) errors.push("URL clip illegally combined with a geometry box");
  return errors;
}
