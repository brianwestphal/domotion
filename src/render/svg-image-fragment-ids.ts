import { parseImageElementTree, type ImageElement } from "./svg-image-selector-engine.js";

export interface ImageFragmentInventory {
  root: ImageElement;
  ids: ReadonlySet<string>;
}

/** Authentication for the existing literal prefixSvgIds spelling subset.
 * DOM-decoded identity alone cannot prove that raw XML will be rewritten.
 * Keep entity/whitespace/ambiguous spellings raster until the shared image
 * reference rewrite is XML-aware (DM-WT73T4). */
export function imageFragmentInventory(svg: string): ImageFragmentInventory | null {
  // This lexical parser cannot authenticate DTD-supplied default attributes
  // or stylesheet processing instructions omitted by ordinary inlining.
  if (/<!DOCTYPE\b|<\?xml-stylesheet\b/i.test(svg)) return null;
  const root = parseImageElementTree(svg, true);
  if (root == null) return null;
  const ids = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    const attributes = element.sourceAttributes;
    if (attributes == null || new Set(attributes.map((attribute) => attribute.name)).size !== attributes.length)
      return null;
    if (
      [...element.attributes.values()].some((value) => value == null) ||
      attributes.some((attribute) => attribute.value.includes("<"))
    )
      return null;
    for (const attribute of attributes) {
      if (attribute.name.toLowerCase() !== "class") continue;
      const value = attribute.value;
      if (
        attribute.name !== "class" ||
        (attribute.syntax !== `class="${value}"` && attribute.syntax !== `class='${value}'`) ||
        !/^[\t\n\r ]*(?:-?[_a-zA-Z][-_a-zA-Z0-9]*(?:[\t\n\r ]+-?[_a-zA-Z][-_a-zA-Z0-9]*)*[\t\n\r ]*)?$/.test(value)
      )
        return null;
    }
    const id = element.attributes.get("id");
    if (id !== undefined) {
      if (id == null || !/^[a-z0-9_.:-]+$/i.test(id) || ids.has(id)) return null;
      const source = attributes.find((attribute) => attribute.name === "id");
      if (source?.syntax !== `id="${id}"` && source?.syntax !== `id='${id}'`) return null;
      ids.add(id);
    }
    pending.push(...element.children);
  }
  return { root, ids };
}
