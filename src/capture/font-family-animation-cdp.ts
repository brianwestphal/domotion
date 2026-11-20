import type { CDPSession } from "@playwright/test";
import {
  canonicalFamily,
  type FamilyKeyframesRule,
  type FamilyResolution,
  type ProvenFamilyType,
} from "./font-family-cascade.js";
import {
  chooseFamilyKeyframe,
  keyframeSelectorOffsets,
  withSyntheticFamilyKeyframes,
  type FamilyKeyframe,
} from "./font-family-animation.js";

/** One animation targeting the element, as the page reports it. */
export interface PageFamilyAnimation {
  kind: "css" | "transition" | "script";
  name: string | null;
  playState: string;
  playbackRate: number;
  documentTimeline: boolean;
  pseudoElement: string | null;
  progress: number | null;
  keyframes: Array<{ offset: number | null; easing: string; fontFamily: string | null; font: boolean; all: boolean }>;
}
export interface PageFamilyAnimations {
  computed: string;
  animations: PageFamilyAnimation[];
}

/** Classify an authored keyframe value through the caller's computed-variable
 * substitution and CSS-wide handling. */
export type FamilyValueClassifier = (value: string, shorthand: boolean) => Promise<FamilyResolution>;

interface AuthoredFamily {
  value: string;
  shorthand: boolean;
}

/** ProcessKeyframesRule + CreateKeyframeEffectModel for the font-family
 * property alone (`core/animation/css/css_animations.cc:406-711`, Chromium
 * 7d859f27): keyframe blocks are stably sorted by offset and, per offset, the
 * LAST block in source order that sets the property wins. */
function authoredFamilyByOffset(rule: FamilyKeyframesRule): Map<number, AuthoredFamily> | string {
  const rows: Array<{ offset: number; family: AuthoredFamily | null }> = [];
  for (const keyframe of rule.keyframes ?? []) {
    const offsets = keyframeSelectorOffsets(keyframe.keyText?.text ?? "");
    if (offsets == null) return "keyframe selector is not a fixed offset";
    const entries = canonicalFamily(keyframe.style);
    if (typeof entries === "string") return entries;
    const last = entries.at(-1);
    if (last != null && (last.important || last.wideOnly)) return "unsupported keyframe family declaration";
    for (const offset of offsets)
      rows.push({ offset, family: last == null ? null : { value: last.value, shorthand: last.shorthand } });
  }
  const map = new Map<number, AuthoredFamily>();
  for (const row of rows) if (row.family != null) map.set(row.offset, row.family);
  return map;
}

const sameOffset = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Property-specific keyframes (with Blink's synthetic neutral boundaries)
 * for one animation, or the reason they cannot be reconstructed exactly. */
function familyKeyframes(
  animation: PageFamilyAnimation,
  rules: FamilyKeyframesRule[] | undefined,
): { keyframes: FamilyKeyframe[]; shorthand: Map<number, boolean> } | string {
  if (animation.keyframes.some((k) => k.font || k.all)) return "animated font shorthand is unproved";
  const withFamily = animation.keyframes.filter((k) => k.fontFamily != null);
  if (withFamily.some((k) => k.offset == null || !Number.isFinite(k.offset))) return "keyframe offset is unresolved";
  const zeroEasings = new Set(animation.keyframes.filter((k) => k.offset === 0).map((k) => k.easing));
  if (zeroEasings.size > 1) return "zero-offset keyframe easing is ambiguous";
  const zeroEasing = [...zeroEasings][0] ?? "linear";
  const shorthand = new Map<number, boolean>();
  let authored: FamilyKeyframe[];
  if (animation.kind === "css") {
    const named = (rules ?? []).filter((rule) => rule.animationName?.text === animation.name);
    if (named.length === 0) return "resolved keyframes rule is unavailable";
    if (named.some((rule) => JSON.stringify(rule.keyframes) !== JSON.stringify(named[0].keyframes)))
      return "animation name resolves to different keyframes rules";
    const byOffset = authoredFamilyByOffset(named[0]);
    if (typeof byOffset === "string") return byOffset;
    authored = [];
    const used = new Set<number>();
    for (const k of withFamily) {
      const offset = k.offset!;
      const match = [...byOffset.keys()].find((o) => sameOffset(o, offset));
      if (match == null) {
        // getKeyframes() injects the synthetic neutral boundaries itself.
        if (offset === 0 || offset === 1) continue;
        return "keyframe structure disagrees with the resolved rule";
      }
      if (used.has(match)) return "keyframe structure disagrees with the resolved rule";
      used.add(match);
      const family = byOffset.get(match)!;
      shorthand.set(authored.length, family.shorthand);
      authored.push({ offset, easing: k.easing, value: family.value });
    }
    if (used.size !== byOffset.size) return "keyframe structure disagrees with the resolved rule";
  } else {
    // Script animations keep their specified values (Element.animate keyframes).
    authored = withFamily.map((k) => ({ offset: k.offset!, easing: k.easing, value: k.fontFamily! }));
  }
  if (authored.length === 0) return "animation has no authored family keyframe";
  const keyframes = withSyntheticFamilyKeyframes(authored, zeroEasing);
  // Re-key shorthand flags onto the final indices.
  const finalShorthand = new Map<number, boolean>();
  keyframes.forEach((k, index) => {
    if (k.value == null) return;
    const source = authored.findIndex((a) => a === k);
    finalShorthand.set(index, shorthand.get(source) ?? false);
  });
  return { keyframes, shorthand: finalShorthand };
}

/**
 * Resolve the family type an element's animation stack applies, from its
 * animations in composite order (topmost last). Returns `{ base: true }` when
 * every layer is neutral at the current progress.
 */
export async function resolveAnimatedFamilyType(
  page: PageFamilyAnimations,
  rules: FamilyKeyframesRule[] | undefined,
  classify: FamilyValueClassifier,
): Promise<FamilyResolution | { base: true }> {
  const animations = page.animations;
  // The inspector reported an animated family; an empty page list means the
  // identity join failed, never that the static cascade applies.
  if (animations.length === 0) return { reason: "animated family has no matching page animation" };
  if (animations.some((a) => a.kind === "transition")) return { reason: "interpolated family lost original type" };
  if (animations.some((a) => !a.documentTimeline)) return { reason: "non-document animation timeline is unproved" };
  if (animations.some((a) => a.pseudoElement != null))
    return { reason: "pseudo-element animation identity is unproved" };
  const groups: Array<{
    animation: PageFamilyAnimation;
    keyframes: FamilyKeyframe[];
    shorthand: Map<number, boolean>;
  }> = [];
  for (const animation of animations) {
    const built = familyKeyframes(animation, rules);
    if (typeof built === "string") return { reason: built };
    groups.push({ animation, ...built });
  }
  const running = animations.some((a) => a.playState === "running" && a.playbackRate !== 0);
  if (running) {
    // A running animation can cross a flip between this read and the capture.
    // Only a stack whose every keyframe applies the same type is time-invariant.
    let type: ProvenFamilyType | undefined;
    for (const group of groups) {
      for (const [index, keyframe] of group.keyframes.entries()) {
        if (keyframe.value == null) return { reason: "running family animation crosses a neutral keyframe" };
        const result = await classify(keyframe.value, group.shorthand.get(index) ?? false);
        if (!("type" in result)) return result;
        if (type != null && type !== result.type) return { reason: "running family animation changes type" };
        type = result.type;
      }
    }
    return type == null ? { base: true } : { type };
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const { animation, keyframes, shorthand } = groups[i];
    if (animation.progress == null) continue;
    const choice = chooseFamilyKeyframe(keyframes, animation.progress);
    if (choice.kind === "unknown") return { reason: choice.reason };
    if (choice.kind === "neutral") continue;
    // A CSS animation's getKeyframes() values are the computed values Blink
    // applies, so the chosen keyframe must reproduce the element's computed
    // family. This rejects a wrong interval or flip side outright.
    if (animation.kind === "css") {
      const serialized = animation.keyframes.filter(
        (k) => k.fontFamily != null && sameOffset(k.offset!, keyframes[choice.index].offset),
      );
      if (serialized.length !== 1 || serialized[0].fontFamily !== page.computed)
        return { reason: "chosen keyframe disagrees with the computed family" };
    }
    return classify(choice.value, shorthand.get(choice.index) ?? false);
  }
  return { base: true };
}

/** Read the element's own animations through the page, in composite order
 * (`Element.getAnimations()` sorts by `Animation::HasLowerCompositeOrdering`). */
export async function readPageFamilyAnimations(session: CDPSession, nodeId: number): Promise<PageFamilyAnimations> {
  const { object } = await session.send("DOM.resolveNode", { nodeId });
  if (object.objectId == null) throw new Error("Chromium did not expose the animated element");
  try {
    const reply = await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        var el = this, out = [];
        var has = function(k, p) { return Object.prototype.hasOwnProperty.call(k, p); };
        el.getAnimations().forEach(function(a) {
          var e = a.effect;
          if (!e || typeof e.getKeyframes !== 'function') return;
          var frames = e.getKeyframes();
          if (!frames.some(function(k) { return has(k, 'fontFamily') || has(k, 'font') || has(k, 'all'); })) return;
          out.push({
            kind: (typeof CSSTransition === 'function' && a instanceof CSSTransition) ? 'transition'
              : (typeof CSSAnimation === 'function' && a instanceof CSSAnimation) ? 'css' : 'script',
            name: typeof a.animationName === 'string' ? a.animationName : null,
            playState: a.playState,
            playbackRate: a.playbackRate,
            documentTimeline: a.timeline instanceof DocumentTimeline,
            pseudoElement: e.pseudoElement || null,
            progress: e.getComputedTiming().progress,
            keyframes: frames.map(function(k) {
              return { offset: typeof k.computedOffset === 'number' ? k.computedOffset : null, easing: String(k.easing),
                fontFamily: has(k, 'fontFamily') ? String(k.fontFamily) : null, font: has(k, 'font'), all: has(k, 'all') };
            })
          });
        });
        return { computed: getComputedStyle(el).fontFamily, animations: out };
      }`,
    });
    if (reply.exceptionDetails != null) throw new Error(reply.exceptionDetails.text);
    return reply.result.value as PageFamilyAnimations;
  } finally {
    await session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
  }
}
