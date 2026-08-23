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
  /**
   * Blink LayoutObject::Preserves3D() after layout applicability and
   * ComputedStyle::UsedTransformStyle3D grouping-property resolution.
   * `null` is an explicit unobservable same-frame fact and activates the
   * conservative Chromium-surface fallback.
   */
  usedPreserve3d?: boolean | null;
  /** Measured live paint quad is non-affine. */
  nonAffine: boolean;
  /** Outermost atomic inline-SVG root whose clone suppresses this node. */
  inlineSvgRoot: number | null;
}

export type ProjectiveSvgRole = "html-box" | "svg-root-box" | "svg-graphics";

/** Computed transform state read in the same committed frame as the CDP quad. */
export interface ProjectiveComputedState {
  transform: string;
  translate: string;
  rotate: string;
  scale: string;
  transformOrigin: string;
  transformStyle: string;
  perspective: string;
  perspectiveOrigin: string;
  overflowX: string;
  overflowY: string;
}

/** Serializable result of the Chromium/CDP paint-quad prepass. */
export interface ProjectivePaintNodeFact extends ProjectiveOwnershipNode {
  role: ProjectiveSvgRole;
  /** DOM.getContentQuads result in capture-viewport coordinates. */
  quad: ProjectivePaintQuad | null;
  /** DOM.getBoxModel border quad, used only for box homography emission. */
  borderQuad: ProjectivePaintQuad | null;
  /** Fourth-corner residual in capture CSS pixels; null means CDP unavailable. */
  residual: number | null;
  /** Present only for nodes participating in the current 3D paint context. */
  computed: ProjectiveComputedState | null;
  /** Same-frame Blink grouping-property discriminators that forced flat. */
  groupingReasons: string[];
  /** Whether this node maps to a LayoutObject on which Preserves3D applies. */
  preserve3dLayoutApplicable: boolean;
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
 * - A plane belongs to the rendering context propagated through direct DOM
 *   parent edges whose LayoutObjects use preserve-3d. Perspective alone does
 *   not propagate a rendering context.
 * - If that edge is below an atomic cloned inline SVG, ownership is promoted
 *   to the SVG root because paintInlineSvg never visits captured descendants.
 * - If another selected owner contains it, only the outer owner survives.
 */
export function selectProjectiveRasterOwnerIndexes(
  nodes: readonly ProjectiveOwnershipNode[],
): number[] {
  const contextRoot = new Map<number, number | null>();
  const propagated = new Map<number, number | null>();
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const inherited = node.parent == null ? null : (propagated.get(node.parent) ?? null);
    const root = inherited ?? (node.usedPreserve3d === true ? index : null);
    contextRoot.set(index, root);
    propagated.set(index, node.usedPreserve3d === true ? root : null);
  }
  const candidates = new Set<number>();

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node == null || !node.nonAffine) continue;

    let owner = contextRoot.get(index) ?? index;
    // A missing internal used-style fact cannot authorize a smaller crop.
    // Retain the former descendant-union owner as an explicit conservative
    // Chromium surface until the same-frame fact becomes observable.
    let cursor: number | null = index;
    let unknown = false;
    while (cursor != null) {
      if (nodes[cursor]?.usedPreserve3d == null) unknown = true;
      cursor = nodes[cursor]?.parent ?? null;
    }
    if (unknown) {
      owner = index;
      let parent = node.parent;
      while (parent != null && nodes[parent]?.influenced === true) {
        owner = parent;
        parent = nodes[parent]?.parent ?? null;
      }
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
