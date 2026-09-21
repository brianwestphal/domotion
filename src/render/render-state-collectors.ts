import type { CapturedElement, ClipPathFragmentDef, MaskFragmentDef, MaskRasterRef } from "../capture/types.js";
import { findOffGridCollapsedCells } from "./borders.js";

export const fragmentDefinitionKey = (id: string, scope?: number): string =>
  scope == null ? id : `${scope}\u0000${id}`;

export function collectParentElements(elements: CapturedElement[]): Map<CapturedElement, CapturedElement> {
  const parents = new Map<CapturedElement, CapturedElement>();
  const visit = (parent: CapturedElement): void => {
    for (const child of parent.children) {
      parents.set(child, parent);
      visit(child);
    }
  };
  for (const root of elements) visit(root);
  return parents;
}

export function collectFragmentMaskDefs(elements: CapturedElement[]): Map<string, MaskFragmentDef> {
  const defs = new Map<string, MaskFragmentDef>();
  for (const root of elements) {
    for (const def of root.maskDefs ?? []) {
      const key = fragmentDefinitionKey(def.id, def.scope);
      if (!defs.has(key)) defs.set(key, def);
    }
  }
  return defs;
}

export function collectFragmentClipPathDefs(elements: CapturedElement[]): Map<string, ClipPathFragmentDef> {
  const defs = new Map<string, ClipPathFragmentDef>();
  for (const root of elements) {
    for (const def of root.clipPathDefs ?? []) {
      const key = fragmentDefinitionKey(def.id, def.scope);
      if (!defs.has(key)) defs.set(key, def);
    }
  }
  return defs;
}

export function collectElementMaskRasters(elements: CapturedElement[]): Map<string, MaskRasterRef> {
  const rasters = new Map<string, MaskRasterRef>();
  for (const root of elements) {
    for (const raster of root.maskRasters ?? []) {
      if (!rasters.has(raster.id)) rasters.set(raster.id, raster);
    }
  }
  return rasters;
}

export function collectFragmentFilterDefs(elements: CapturedElement[]): Map<string, { id: string; outerHTML: string }> {
  const defs = new Map<string, { id: string; outerHTML: string }>();
  for (const root of elements) {
    for (const def of root.filterDefs ?? []) {
      if (!defs.has(def.id)) defs.set(def.id, def);
    }
  }
  return defs;
}

export function collectOffGridCollapsedCells(elements: CapturedElement[]): Set<CapturedElement> {
  const result = new Set<CapturedElement>();
  // DM-1260: the shifted-consensus heuristic must run per table. Otherwise
  // unrelated coordinates in a second table can vote a cell in the first
  // table off-grid and incorrectly disable collapsed-border centering.
  const groups = new Map<CapturedElement, CapturedElement[]>();
  const collect = (element: CapturedElement, table: CapturedElement | null): void => {
    const owner = element.tag === "table" ? element : table;
    if (
      owner != null &&
      element.styles?.borderCollapse === "collapse" &&
      (element.tag === "td" || element.tag === "th")
    ) {
      const cells = groups.get(owner);
      if (cells == null) groups.set(owner, [element]);
      else cells.push(element);
    }
    for (const child of element.children) collect(child, owner);
  };
  for (const root of elements) collect(root, null);
  for (const cells of groups.values()) {
    const offGrid = findOffGridCollapsedCells(cells);
    for (let index = 0; index < cells.length; index++) {
      if (offGrid[index]) result.add(cells[index]);
    }
  }
  return result;
}
