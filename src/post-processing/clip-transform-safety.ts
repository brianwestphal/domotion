/**
 * Guard against a Firefox-only cross-browser trap (DM-1529): `transform-box:
 * fill-box` is IGNORED on a child of `<clipPath>` / `<mask>`. Firefox pivots a
 * `transform` on such an element about the SVG viewport origin (0,0) instead of
 * the element's own box, so an animated clip/mask shape lands in the wrong place
 * and silently clips content wrong — but ONLY in Firefox, and ONLY when the
 * fill-box element is the clip/mask *shape* itself. On ordinary rendered
 * elements (including ones nested/composited and clipped by an ancestor) Firefox
 * honors fill-box, so those are safe.
 *
 * The insidious part is composition: a template SVG that's perfectly safe on its
 * own can become unsafe if a later step routes it into a `<clipPath>`/`<mask>`.
 * So the invariant is enforced at the OUTPUT level, not per-generator:
 *
 *   No element inside a `<clipPath>` or `<mask>` may carry `transform-box:
 *   fill-box` (inline OR via a class rule). Position clip/mask transforms with an
 *   explicit userspace `transform-origin` instead (see
 *   `resolveClipOriginPx` in src/animation/composite.ts).
 *
 * This module DETECTS violations (it does not auto-rewrite — a correct rewrite
 * needs the element's box, which is only cheaply known where the clip/mask is
 * constructed). `composeAnimatedLayers` (src/animation/composite.ts) runs
 * `findFillBoxInClipOrMask` over each input layer and surfaces any hit as a
 * non-fatal warning (`CompositeResult.warnings` + `console.warn`) — Domotion's
 * own generators never emit the trap, so this only fires on a caller-supplied
 * layer. `assertNoFillBoxInClipOrMask` is the throwing variant for callers /
 * tests that want a violation to fail fast rather than warn. See docs/84.
 */

/** Class names whose `<style>` rule sets `transform-box: fill-box`. */
function fillBoxClasses(svg: string): Set<string> {
  const classes = new Set<string>();
  for (const m of svg.matchAll(/\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g)) {
    if (/transform-box\s*:\s*fill-box/.test(m[2])) classes.add(m[1]);
  }
  return classes;
}

/**
 * Return a list of human-readable violations: every `transform-box: fill-box`
 * (inline style or via a class rule) that appears on an element inside a
 * `<clipPath>` or `<mask>`. Empty array = safe. Reliable for Domotion's own
 * output (simple single-class selectors, non-nested clip/mask defs); it is a
 * guard for our generators, not a general CSS-cascade resolver.
 */
export function findFillBoxInClipOrMask(svg: string): string[] {
  const violations: string[] = [];
  const fbClasses = fillBoxClasses(svg);
  for (const block of svg.matchAll(/<(clipPath|mask)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const tag = block[1];
    const inner = block[2];
    if (/style="[^"]*transform-box\s*:\s*fill-box/.test(inner)) {
      violations.push(`<${tag}> child has inline transform-box:fill-box`);
    }
    for (const cm of inner.matchAll(/class="([^"]*)"/g)) {
      for (const cls of cm[1].split(/\s+/)) {
        if (fbClasses.has(cls)) violations.push(`<${tag}> child uses class ".${cls}" (transform-box:fill-box)`);
      }
    }
  }
  return violations;
}

/** Throw if `svg` puts `transform-box: fill-box` inside a clip/mask (DM-1529). */
export function assertNoFillBoxInClipOrMask(svg: string, context = "svg"): void {
  const v = findFillBoxInClipOrMask(svg);
  if (v.length > 0) {
    throw new Error(
      `${context}: transform-box:fill-box inside <clipPath>/<mask> is ignored by Firefox (DM-1529). ` +
      `Use an explicit userspace transform-origin instead. Violations: ${v.join("; ")}`,
    );
  }
}
