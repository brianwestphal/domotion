/**
 * DM-1564 (docs/94 option 3): MutationObserver JS-change harness.
 *
 * `forceState` (docs/94 v1) captures a page's CSS `:hover` / `:active` / `:focus`
 * styling, but it can't catch feedback a page drives with **JavaScript** — a
 * framework toggling a class, injecting a tooltip / dropdown / menu, swapping text
 * on `mouseover` / `mousedown`. Those are actual DOM mutations, invisible to CSS
 * pseudo-state forcing.
 *
 * This module dispatches a real pointer event at a target, installs a
 * `MutationObserver` around it, and waits for the page's JS to **settle** (a quiet
 * debounce window, capped by an overall timeout) before the caller re-captures.
 * It reports what mutated (added / removed nodes, attribute, character-data), so
 * the caller can decide whether there was any JS feedback to show and how to
 * synthesize it.
 *
 * v1 synthesizes ADDED / REMOVED nodes (a menu appearing, a tooltip injected) as a
 * rest→after **crossfade** — composed as a nested animated SVG the same way
 * `typeResample` (DM-1556) and `cast` frames nest, so it needs no animator change.
 * Attribute-/style-only deltas currently ride the same crossfade (they dissolve);
 * routing those through a property-accurate computed-style-diff TWEEN (docs/94
 * option 2's engine) is a follow-up that composes with the CSS-diff path.
 */

import type { Page } from "@playwright/test";
import type { AnimationFrame } from "../animation/index.js";
import { generateAnimatedSvg } from "../animation/index.js";
import { captureElementTree } from "../capture/index.js";
import { elementTreeToSvgInner } from "../render/index.js";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";
import { frameAdvanceMs } from "../animation/frame-timeline.js";
import { captureStyleSnapshot, diffHoverSnapshots, classifyHoverTransition, HOVER_DIFF_PROPERTIES, type HoverDiff } from "./hover-detect.js";
import type { IntraFrameAnimation } from "../animation/overlay-schema.js";
import type { CapturedElement } from "../capture/types.js";

/** The anim id the jsReveal tween targets on the mutated element (DM-1580). */
const JS_REVEAL_ANIM_ID = "jr0";

/** DM-1580: build the intra-frame tween for an attribute/style-only motion
 *  mutation — the target's transform (and/or opacity) morphing from its rest to
 *  its settled value, so a class flip that only moves/scales the element animates
 *  in place instead of dissolving. Mirrors `hover-detect`'s motion synthesis but
 *  targets a resolved `animId`. Returns `[]` when there's no motion track. */
export function synthMutationTween(diff: HoverDiff, animId: string, durationMs: number): IntraFrameAnimation[] {
  const target = diff.motion.filter((d) => d.key === "");
  const transform = target.find((d) => d.property === "transform");
  const opacity = target.find((d) => d.property === "opacity");
  if (transform != null) {
    const anim: IntraFrameAnimation = {
      animId, property: "transform", from: transform.from, to: transform.to,
      duration: durationMs, easing: "ease-out", transformOrigin: "center",
    };
    if (opacity != null) anim.fuse = [{ property: "opacity", from: opacity.from, to: opacity.to }];
    return [anim];
  }
  if (opacity != null) {
    return [{ animId, property: "opacity", from: opacity.from, to: opacity.to, duration: durationMs, easing: "ease-out" }];
  }
  return [];
}

/** Clear a captured element tree's `animId` tags (DM-1580) — used to strip the
 *  jsReveal target's tween tag from the tree when the mutation takes the crossfade
 *  path, so its `restSvg` is byte-identical to the pre-feature output. */
function clearAnimIds(tree: CapturedElement[]): void {
  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      if (el.animId != null) el.animId = undefined;
      if (el.children != null) walk(el.children);
    }
  };
  walk(tree);
}

/** The pointer events the harness can dispatch. Mouse/pointer only, so the event
 *  object is constructed with the right coordinates + bubbling. */
export const MUTATION_DETECT_EVENTS = [
  "mouseover", "mouseenter", "mousedown", "mouseup", "click",
  "pointerover", "pointerenter", "pointerdown",
] as const;
export type MutationDetectEvent = (typeof MUTATION_DETECT_EVENTS)[number];

/** Resolved (defaults applied) `jsReveal` spec. */
export interface JsRevealSpec {
  /** The element to dispatch the pointer event at. */
  selector: string;
  /** The pointer event to dispatch (default `mouseover`). */
  event: MutationDetectEvent;
  /** Max ms to wait for the page's JS mutations to settle. Default 600. */
  settleMs: number;
  /** Quiet window (ms) with no mutations that counts as "settled". Default 120. */
  debounceMs: number;
  /** Rest hold + after hold, each in ms. Default 700. */
  holdMs: number;
  /** The rest→after crossfade duration (ms). Default 300. */
  crossfadeMs: number;
}

/** Defaults for the optional `jsReveal` fields (docs/94 option 3). */
export const JS_REVEAL_DEFAULTS = {
  event: "mouseover" as MutationDetectEvent,
  settleMs: 600,
  debounceMs: 120,
  holdMs: 700,
  crossfadeMs: 300,
};

export function resolveJsRevealSpec(raw: {
  selector: string;
  event?: MutationDetectEvent;
  settleMs?: number;
  debounceMs?: number;
  holdMs?: number;
  crossfadeMs?: number;
}): JsRevealSpec {
  return {
    selector: raw.selector,
    event: raw.event ?? JS_REVEAL_DEFAULTS.event,
    settleMs: raw.settleMs ?? JS_REVEAL_DEFAULTS.settleMs,
    debounceMs: raw.debounceMs ?? JS_REVEAL_DEFAULTS.debounceMs,
    holdMs: raw.holdMs ?? JS_REVEAL_DEFAULTS.holdMs,
    crossfadeMs: raw.crossfadeMs ?? JS_REVEAL_DEFAULTS.crossfadeMs,
  };
}

/** What the MutationObserver saw between the dispatch and the settle. */
export interface MutationSummary {
  /** Nodes added anywhere in the document subtree. */
  addedNodes: number;
  /** Nodes removed. */
  removedNodes: number;
  /** Attribute changes (class flips, aria-*, style, …). */
  attributes: number;
  /** Character-data (text) changes. */
  characterData: number;
  /** Why the wait ended: mutations went quiet, or the overall timeout hit. */
  reason: "settled" | "timeout";
  /** True if ANY mutation was observed. */
  changed: boolean;
  /** True if the feedback added or removed DOM nodes (→ crossfade is the right synthesis). */
  structural: boolean;
}

/**
 * Dispatch `spec.event` at `spec.selector`, observe the resulting DOM mutations,
 * and resolve once they settle (a `debounceMs` quiet window) or `settleMs`
 * elapses. Everything runs inside ONE `page.evaluate` so the observer is armed
 * before the event fires and no synchronous mutation is missed. Leaves the
 * mutated DOM in place (the caller re-captures it). Throws if the selector matches
 * nothing (same fail-fast as an action selector).
 *
 * Pure-ish: the only side effect is the dispatched event + whatever the page's own
 * handlers do; the observer is disconnected before returning.
 */
export async function detectJsMutations(page: Page, spec: JsRevealSpec): Promise<MutationSummary> {
  const summary = await page.evaluate(
    async (args: { selector: string; event: string; settleMs: number; debounceMs: number }) => {
      const target = document.querySelector(args.selector);
      if (target == null) return { notFound: true } as const;

      let addedNodes = 0;
      let removedNodes = 0;
      let attributes = 0;
      let characterData = 0;

      let settle: (reason: "settled") => void;
      const settled = new Promise<"settled">((r) => { settle = r; });
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const armQuiet = (): void => {
        if (quietTimer != null) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => settle("settled"), args.debounceMs);
      };

      const obs = new MutationObserver((records) => {
        for (const rec of records) {
          if (rec.type === "childList") {
            addedNodes += rec.addedNodes.length;
            removedNodes += rec.removedNodes.length;
          } else if (rec.type === "attributes") {
            attributes += 1;
          } else if (rec.type === "characterData") {
            characterData += 1;
          }
        }
        armQuiet();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

      // Build the pointer event with the target's center as the pointer position,
      // so JS that reads clientX/clientY (a tooltip that positions at the cursor)
      // gets sensible coordinates. `*enter` events don't bubble.
      const rect = target.getBoundingClientRect();
      const isEnter = args.event.endsWith("enter");
      const init: MouseEventInit = {
        bubbles: !isEnter,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      const ev = args.event.startsWith("pointer")
        ? new PointerEvent(args.event, init)
        : new MouseEvent(args.event, init);
      target.dispatchEvent(ev);

      const timedOut = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), args.settleMs));
      const reason = await Promise.race([settled, timedOut]);
      obs.disconnect();
      if (quietTimer != null) clearTimeout(quietTimer);

      const changed = addedNodes + removedNodes + attributes + characterData > 0;
      const structural = addedNodes + removedNodes > 0;
      return { notFound: false, addedNodes, removedNodes, attributes, characterData, reason, changed, structural };
    },
    { selector: spec.selector, event: spec.event, settleMs: spec.settleMs, debounceMs: spec.debounceMs },
  );

  if (summary.notFound) {
    throw new Error(`animate: jsReveal selector "${spec.selector}" matched no element`);
  }
  return {
    addedNodes: summary.addedNodes,
    removedNodes: summary.removedNodes,
    attributes: summary.attributes,
    characterData: summary.characterData,
    reason: summary.reason,
    changed: summary.changed,
    structural: summary.structural,
  };
}

/**
 * Run the full JS-reveal harness against a live page and compose the result as a
 * nested animated SVG ready to drop into one outer animate frame's `svgContent`
 * (XML prolog stripped, document-global names namespaced with `framePrefix`).
 *
 * Captures the REST state, dispatches the pointer event + observes until settle,
 * captures the AFTER state, and — when the page's JS actually changed the DOM —
 * composes a rest→after crossfade. When nothing mutated, it logs a note and emits
 * just the rest state (a still frame): there was no feedback to reveal, so we
 * don't invent one. Pair the returned `periodMs` with the frame's
 * `embeddedAnimationPeriodMs` so the animator re-anchors it (like a `cast` frame).
 */
export async function buildJsRevealAnimation(
  page: Page,
  spec: JsRevealSpec,
  opts: { width: number; height: number; framePrefix: string; log: (msg: string) => void },
): Promise<{ svgContent: string; periodMs: number; rootBg: string | undefined; summary: MutationSummary }> {
  const { width, height, framePrefix, log } = opts;

  // DM-1580: tag the target so a non-structural motion mutation (a class flip that
  // moves/scales it) can TWEEN in place via the intra-frame animator, rather than
  // dissolving. The tag rides the rest capture; it's stripped again (clearAnimIds)
  // on every path except the tween, so the crossfade / rest-only `restSvg` stays
  // byte-identical to the pre-feature output.
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement) el.dataset.domotionAnim = "jr0";
  }, spec.selector).catch(() => { /* selector may be absent; falls through to crossfade */ });

  // 1. REST — the page before the pointer event (tree + the target's style snapshot).
  const restTree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
  cullElementsOutsideViewBox(restTree, width, height, undefined, 0, 1);
  const rootBg = restTree[0]?.styles?.rootBgComputed;
  const restSnap = await captureStyleSnapshot(page, spec.selector, HOVER_DIFF_PROPERTIES).catch(() => null);
  const renderRest = (): string => elementTreeToSvgInner(restTree, width, height, `${framePrefix}s0-`, true, 2, false);

  // 2. Dispatch + observe + settle.
  const summary = await detectJsMutations(page, spec);
  log(
    `  jsReveal: dispatched ${spec.event} on "${spec.selector}" → ` +
      `+${summary.addedNodes}/-${summary.removedNodes} nodes, ${summary.attributes} attr, ` +
      `${summary.characterData} text (${summary.reason})`,
  );

  const subFrames: AnimationFrame[] = [];
  if (!summary.changed) {
    log(`  jsReveal: no DOM mutations observed — emitting the rest state only (nothing to reveal)`);
    clearAnimIds(restTree);
    // `cut` (not "no transition") so the single-state loop period is exactly holdMs.
    subFrames.push({ svgContent: renderRest(), duration: spec.holdMs, transition: { type: "cut", duration: 0 } });
  } else {
    // DM-1580: an attribute/style-only mutation that MOVES the target (transform /
    // opacity) tweens in place instead of crossfading. Diff the target's rest vs
    // settled computed styles (the same engine `hoverDetect` uses); a `motion`
    // classification → an intra-frame tween on the tagged element.
    let tweened = false;
    if (!summary.structural && restSnap != null) {
      const afterSnap = await captureStyleSnapshot(page, spec.selector, HOVER_DIFF_PROPERTIES).catch(() => null);
      const diff = afterSnap != null ? diffHoverSnapshots(restSnap, afterSnap) : null;
      if (diff != null && classifyHoverTransition(diff) === "motion") {
        const anims = synthMutationTween(diff, JS_REVEAL_ANIM_ID, spec.crossfadeMs);
        if (anims.length > 0) {
          log(`  jsReveal: attribute/style-only motion on "${spec.selector}" → intra-frame ${anims.map((a) => a.property).join("+")} tween (not a crossfade)`);
          // Single frame, rest state, tweening in place; loops on its own holdMs clock.
          subFrames.push({ svgContent: renderRest(), duration: spec.holdMs, animations: anims, transition: { type: "cut", duration: 0 } });
          tweened = true;
        }
      }
    }
    if (!tweened) {
      if (!summary.structural) {
        log(
          `  jsReveal: attribute/text changes with no tweenable motion delta — ` +
            `synthesizing as a crossfade (paint-only / non-target change)`,
        );
      }
      clearAnimIds(restTree);
      // 3. AFTER — the settled, mutated page. The `data-domotion-anim` tag still
      // rides the DOM, so strip it from this capture too — the crossfade never
      // uses the tween tag (byte-identical to the pre-feature output).
      const afterTree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      cullElementsOutsideViewBox(afterTree, width, height, undefined, 0, 1);
      clearAnimIds(afterTree);
      const afterSvg = elementTreeToSvgInner(afterTree, width, height, `${framePrefix}s1-`, true, 2, false);
      subFrames.push({ svgContent: renderRest(), duration: spec.holdMs, transition: { type: "crossfade", duration: spec.crossfadeMs } });
      subFrames.push({ svgContent: afterSvg, duration: spec.holdMs });
    }
  }

  const nested = generateAnimatedSvg({
    width,
    height,
    frames: subFrames,
    fontFaceCss: "",
    ...(rootBg != null ? { background: rootBg } : {}),
  });
  const namespaced = namespaceEmbeddedAnimatedSvg(nested, framePrefix, { namespaceFonts: false });
  const svgContent = namespaced.replace(/^<\?xml[^>]*\?>\s*/, "");
  const periodMs = subFrames.reduce((sum, f) => sum + frameAdvanceMs(f), 0);
  return { svgContent, periodMs, rootBg, summary };
}
