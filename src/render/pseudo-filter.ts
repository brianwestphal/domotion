import { esc, r } from "./format.js";

export interface PseudoPaintEffects {
  x: number;
  y: number;
  width: number;
  height: number;
  filter?: string;
  opacity?: number;
  transform?: string;
  transformOrigin?: string;
}

function transformOrigin(
  value: string | undefined,
  box: Pick<PseudoPaintEffects, "x" | "y" | "width" | "height">,
): [number, number] {
  const fallback: [number, number] = [
    box.x + box.width / 2,
    box.y + box.height / 2,
  ];
  if (!value) return fallback;

  const parts = value.trim().split(/\s+/);
  const ox = Number.parseFloat(parts[0] ?? "");
  const oy = Number.parseFloat(parts[1] ?? "");
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return fallback;
  return [box.x + ox, box.y + oy];
}

/**
 * Apply the effects owned by a generated pseudo-element to its complete paint.
 *
 * Keep the computed CSS filter list intact instead of lowering it to SVG filter
 * primitives. Blink's FilterEffectBuilder applies the list in source order and
 * gives CSS shorthand functions sRGB operating space, unclipped primitive
 * bounds, and premultiplication validation. A hand-authored `<fe*>` graph would
 * otherwise inherit SVG's different defaults. The nesting mirrors Blink paint
 * property ownership: content -> filter -> transform -> opacity/primary effect.
 *
 * Source: Chromium 7d859f271cbda744098ac69f44978d4edfa62be3,
 * third_party/blink/renderer/core/paint/filter_effect_builder.cc and
 * third_party/blink/renderer/core/paint/paint_property_tree_builder.cc.
 */
export function wrapPseudoPaintEffects(
  box: PseudoPaintEffects,
  content: string,
): string {
  let result = content;

  const filter = box.filter?.trim();
  if (filter && filter !== "none") {
    result = `<g style="${esc(`filter:${filter}`)}">${result}</g>`;
  }

  const transform = box.transform?.trim();
  if (transform && transform !== "none") {
    const [ox, oy] = transformOrigin(box.transformOrigin, box);
    result = `<g transform="translate(${r(ox)} ${r(oy)}) ${esc(transform)} translate(${r(-ox)} ${r(-oy)})">${result}</g>`;
  }

  if (box.opacity != null && Number.isFinite(box.opacity) && box.opacity < 1) {
    result = `<g opacity="${String(Math.max(0, Math.min(1, box.opacity)))}">${result}</g>`;
  }

  return result;
}
