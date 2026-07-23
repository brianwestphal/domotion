import type { CapturedElement } from "../capture/types.js";
import { forEachElement } from "./for-each-element.js";

/**
 * The slice of an intra-frame animation this pass needs: which `animId` it
 * targets and which CSS properties it animates (the primary `property` plus
 * any fused tracks). Structurally satisfied by `IntraFrameAnimation`.
 */
export interface AnimatedPropertySpec {
  animId: string;
  property: string;
  fuse?: Array<{ property: string }>;
}

/**
 * Pre-render annotation pass: record, on every captured element that an
 * intra-frame animation targets (matched by `animId`), WHICH CSS properties
 * those animations animate — `el.animatedProperties`.
 *
 * Why the renderer needs this: the renderer bakes captured state into static
 * markup (e.g. the element's captured `opacity` becomes a wrapper
 * `<g opacity="...">`, and `opacity: 0` elements are dropped entirely as a
 * size win). When an animation owns one of those channels, baking it breaks
 * the animation — a baked 0.2 wrapper multiplies with an opacity keyframe
 * 0.2→1 so the element can never brighten past its captured value, and a
 * dropped `opacity: 0` element leaves nothing in the SVG to fade in. The
 * renderer stays ignorant of animation configs; this annotation is its only
 * signal that "an animation owns property X on this element — don't bake it."
 *
 * Mutates the tree in place. A no-op when `animations` is empty/undefined.
 * Elements whose `animId` matches no animation are left untouched.
 */
export function annotateAnimatedProperties(
  tree: CapturedElement[],
  animations: readonly AnimatedPropertySpec[] | undefined,
): void {
  if (animations == null || animations.length === 0) return;
  const propsById = new Map<string, Set<string>>();
  for (const a of animations) {
    let props = propsById.get(a.animId);
    if (props == null) {
      props = new Set<string>();
      propsById.set(a.animId, props);
    }
    props.add(a.property);
    for (const track of a.fuse ?? []) props.add(track.property);
  }
  forEachElement(tree, (el) => {
    if (el.animId == null || el.animId === "") return;
    const props = propsById.get(el.animId);
    if (props != null) el.animatedProperties = [...props];
  });
}
