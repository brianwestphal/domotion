/**
 * Browser-owned CSS 3D paint facts used by the capture prepass.
 *
 * Blink keeps SVG graphics children on its SVG-specific affine transform path,
 * while the outer SVG root and HTML descendants of <foreignObject> are layout
 * boxes on the general 4x4 paint path.  The capture side therefore selects an
 * owner from measured paint quads, then promotes an owner hidden below an
 * atomic cloned inline SVG to that SVG root.
 */

export type ProjectivePaintQuad = readonly [
  number, number,
  number, number,
  number, number,
  number, number,
];

export interface ProjectiveOwnershipNode {
  /** Parent node index, or null at the selected capture root. */
  parent: number | null;
  /** This node participates in a transform/perspective rendering context. */
  influenced: boolean;
  /** Measured live paint quad is non-affine. */
  nonAffine: boolean;
  /** Outermost atomic inline-SVG root whose clone suppresses this node. */
  inlineSvgRoot: number | null;
}

export type ProjectiveSvgRole = "html-box" | "svg-root-box" | "svg-graphics";

/** Serializable result of the Chromium/CDP paint-quad prepass. */
export interface ProjectivePaintNodeFact extends ProjectiveOwnershipNode {
  role: ProjectiveSvgRole;
  /** DOM.getContentQuads result in capture-viewport coordinates. */
  quad: ProjectivePaintQuad | null;
  /** DOM.getBoxModel border quad, used only for box homography emission. */
  borderQuad: ProjectivePaintQuad | null;
}

export const PROJECTIVE_QUAD_EPSILON = 0.02;

/**
 * A four-corner plane is affine iff q2 = q1 + q3 - q0.  This is a logical
 * activation discriminator, not a screenshot tolerance.
 */
export function projectiveQuadResidual(quad: ProjectivePaintQuad): number {
  const dx = quad[4] - (quad[2] + quad[6] - quad[0]);
  const dy = quad[5] - (quad[3] + quad[7] - quad[1]);
  return Math.hypot(dx, dy);
}

export function isNonAffineProjectiveQuad(
  quad: ProjectivePaintQuad,
  epsilon = PROJECTIVE_QUAD_EPSILON,
): boolean {
  return projectiveQuadResidual(quad) > epsilon;
}

function isAncestor(
  nodes: readonly ProjectiveOwnershipNode[],
  ancestor: number,
  descendant: number,
): boolean {
  let cursor: number | null = descendant;
  while (cursor != null) {
    if (cursor === ancestor) return true;
    cursor = nodes[cursor]?.parent ?? null;
  }
  return false;
}

/**
 * Select the effective Chromium surface owners for measured non-affine paint.
 *
 * - A plane first climbs to the outer edge of its live 3D-influenced context.
 * - If that edge is below an atomic cloned inline SVG, ownership is promoted
 *   to the SVG root because paintInlineSvg never visits captured descendants.
 * - If another selected owner contains it, only the outer owner survives.
 */
export function selectProjectiveRasterOwnerIndexes(
  nodes: readonly ProjectiveOwnershipNode[],
): number[] {
  const candidates = new Set<number>();

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node == null || !node.nonAffine) continue;

    let owner = index;
    let parent = node.parent;
    while (parent != null && nodes[parent]?.influenced === true) {
      owner = parent;
      parent = nodes[parent]?.parent ?? null;
    }

    const inlineSvgRoot = node.inlineSvgRoot;
    if (inlineSvgRoot != null && isAncestor(nodes, inlineSvgRoot, owner)) {
      owner = inlineSvgRoot;
    }
    candidates.add(owner);
  }

  return [...candidates]
    .filter((candidate) => ![...candidates].some(
      (other) => other !== candidate && isAncestor(nodes, other, candidate),
    ))
    .sort((a, b) => a - b);
}
