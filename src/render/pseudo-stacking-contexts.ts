import type { CapturedElement, CapturedPseudoFragmentSet } from "../capture/types.js";
import { establishesStackingContext, isFlexOrGridContainerDisplay, isOverflowOnlySC } from "./stacking.js";

export interface OwnedStackedPseudo {
  owner: CapturedElement;
  record: CapturedPseudoFragmentSet;
  /** Non-context ancestors, outermost first, including the generated child's host. */
  ancestors: CapturedElement[];
  pseudo: CapturedPseudoFragmentSet["pseudo"];
  paint: CapturedPseudoFragmentSet["paint"];
  treeOrder: number;
}

export interface PseudoStackingContexts {
  contexts: Map<CapturedElement | null, OwnedStackedPseudo[]>;
  managed: Set<CapturedPseudoFragmentSet>;
  treeOrder: Map<CapturedElement, number>;
  recordOrder: Map<CapturedPseudoFragmentSet, number>;
  unavailable: Array<{ owner: CapturedElement; reason: string }>;
}

/** Source-owned whole surfaces already include their generated descendants. */
function ownsOpaqueSurface(element: CapturedElement): boolean {
  return (
    element.projectiveHidden === true ||
    element.nativeControlRaster != null ||
    element.externalCssSvgRaster != null ||
    element.svgContent != null ||
    element.urlFilterRaster?.empty === true ||
    element.urlFilterRaster?.dataUri != null ||
    element.transformSubtreeRaster?.empty === true ||
    element.transformSubtreeRaster?.dataUri != null ||
    element.backdropCompositeRaster?.dataUri != null
  );
}

/**
 * Blink 6b5a1b80 PaintLayerStackingNode collects generated layers with ordinary
 * children, through non-context ancestors, then stable-sorts effective z-index.
 * Nonnegative positioned layers are admitted here; the existing negative and
 * legacy3D paths retain their separate paint ownership.
 * Keep this paint-only plan separate from the immutable captured element tree.
 */
export function collectPseudoStackingContexts(elements: readonly CapturedElement[]): PseudoStackingContexts {
  const result: PseudoStackingContexts = {
    contexts: new Map(),
    managed: new Set(),
    treeOrder: new Map(),
    recordOrder: new Map(),
    unavailable: [],
  };
  const unavailableContexts = new Map<CapturedElement | null, CapturedElement>();
  // Native OrderLessThan only inspects a layer's layout parent/grandparent.
  // Deep non-layer wrappers cannot be projected from order-modified DOM order
  // without knowing the native PaintLayer ancestry. Preserve the old context
  // together, rather than mixing a guessed rank with managed generated paint.
  const hasUnavailableLayerOrder = (path: CapturedElement[], generated: boolean): boolean =>
    path.some((parent, index) => {
      const item = path[index + 1];
      if (item == null || !isFlexOrGridContainerDisplay(parent.styles.display)) return false;
      if (["absolute", "fixed"].includes(item.styles.position)) return false;
      const order = Number.parseInt(item.styles.order ?? "0", 10) || 0;
      const distance = path.length - 1 + Number(generated) - (index + 1);
      return order !== 0 && distance > 1;
    });
  let ordinal = 0;
  const visit = (
    element: CapturedElement,
    context: CapturedElement | null,
    ancestors: CapturedElement[],
    in3d: boolean,
    opaque: boolean,
    parentDisplay?: string,
  ): void => {
    result.treeOrder.set(element, ordinal++);
    const opaquePath = opaque || ownsOpaqueSurface(element);
    const realContext = establishesStackingContext(element, parentDisplay) && !isOverflowOnlySC(element);
    const contextPath = [...(context == null ? [] : [context]), ...ancestors, element];
    if (
      (realContext || ["relative", "absolute", "fixed", "sticky"].includes(element.styles.position)) &&
      hasUnavailableLayerOrder(contextPath, false)
    ) {
      unavailableContexts.set(context, element);
    }
    const ownerContext = realContext ? element : context;
    const chain = realContext ? [] : [...ancestors, element];
    const context3d = realContext ? element.styles.transformStyle === "preserve-3d" : in3d;
    type Child = { element: CapturedElement; record?: never } | { record: CapturedPseudoFragmentSet; element?: never };
    const records = element.pseudoFragments ?? [];
    const before = records
      .filter((record) => record.pseudo !== "::after")
      .sort((a, b) => Number(a.pseudo !== "::checkmark") - Number(b.pseudo !== "::checkmark"));
    const children: Child[] = [
      ...before.map((record) => ({ record })),
      ...(element.children ?? []).map((child) => ({ element: child })),
      ...records.filter((record) => record.pseudo === "::after").map((record) => ({ record })),
    ];
    const flexGrid = isFlexOrGridContainerDisplay(element.styles.display);
    // OrderLessThan treats direct out-of-flow children as order0. Flex direction
    // changes layout, not the source order used by the stable layer z-sort.
    const orderOf = (child: Child): number => {
      const position = child.element?.styles.position ?? child.record!.paint.position;
      if (position === "absolute" || position === "fixed") return 0;
      return child.element != null
        ? Number.parseInt(child.element.styles.order ?? "0", 10) || 0
        : (child.record!.paint.order ?? 0);
    };
    if (flexGrid) children.sort((left, right) => orderOf(left) - orderOf(right));
    for (const child of children) {
      if (child.element != null) {
        visit(child.element, ownerContext, chain, context3d, opaquePath, element.styles.display);
        continue;
      }
      const record = child.record;
      const treeOrder = ordinal++;
      result.recordOrder.set(record, treeOrder);
      if (opaquePath) continue;
      if (!["relative", "absolute", "fixed", "sticky"].includes(record.paint.position)) continue;
      if (context3d || (record.paint.zIndex ?? 0) < 0) continue; // Existing projective/legacy3D ownership remains unchanged.
      if (!realContext && hasUnavailableLayerOrder(contextPath, true)) {
        unavailableContexts.set(ownerContext, element);
      }
      if (flexGrid && !["absolute", "fixed"].includes(record.paint.position) && !Number.isFinite(record.paint.order)) {
        result.unavailable.push({ owner: element, reason: "generated flex/grid item source order is unavailable" });
        continue;
      }
      const entry: OwnedStackedPseudo = {
        owner: element,
        record,
        ancestors: chain,
        pseudo: record.pseudo,
        paint: record.paint,
        treeOrder,
      };
      const entries = result.contexts.get(ownerContext) ?? [];
      entries.push(entry);
      result.contexts.set(ownerContext, entries);
      result.managed.add(record);
    }
  };
  for (const element of elements) visit(element, null, [], false, false);
  for (const [context, owner] of unavailableContexts) {
    const entries = result.contexts.get(context);
    if (entries == null) continue;
    for (const entry of entries) result.managed.delete(entry.record);
    result.contexts.delete(context);
    result.unavailable.push({ owner, reason: "deep flex/grid native layer order is unavailable" });
  }
  return result;
}
