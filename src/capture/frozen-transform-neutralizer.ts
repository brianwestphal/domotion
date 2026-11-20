/**
 * Live-page neutralization of the transforms the renderer re-applies.
 *
 * The capture walk freezes every rotation/skew and every other static planar
 * affine transform (`transformFreezes` in `src/capture/script/walker/transforms.ts`):
 * it records the untransformed local box and the renderer wraps it in
 * `<g transform>`. A Node-side pass that reads Chromium geometry or pixels after
 * the walk sees the live, transformed page, which is the wrong coordinate space
 * for anything the renderer emits inside those wrappers.
 * `withFrozenTransformsNeutralized` sets exactly that frozen set to the identity
 * for the duration of `work`, so CDP box models and screenshots come back in
 * the same local space as the captured tree.
 *
 * The identity is written as `translate(0)`, as the walk does, not `none`: a
 * transformed box remains the containing block of its fixed-position
 * descendants and keeps its stacking context, so neutralization never moves
 * layout. The decision is the walker's own `transformFreezes`, shipped into the
 * page as source (the `browserCallbackExpression` pattern), so the two cannot
 * drift apart.
 */

import type { Page } from "@playwright/test";
import { privateCaptureKey } from "./private-key.js";
import {
  composeEffectiveTransform,
  neutralizeTransformForFreeze,
  parseAngleToDeg,
  resolveTranslateComponent,
  transformFreezes,
  transformHasRotationOrSkew,
  transformIsAnimated,
  transformWrapsAsAffine2D,
  transitionCoversTransform,
  TRANSFORM_PROPERTIES,
} from "./script/walker/transforms.js";

/** Source of the walker's freeze predicate and everything it calls, in one scope. */
export function frozenTransformPredicateSource(): string {
  return [
    `const TRANSFORM_PROPERTIES = ${JSON.stringify(TRANSFORM_PROPERTIES)};`,
    `const parseAngleToDeg = (${parseAngleToDeg.toString()});`,
    `const resolveTranslateComponent = (${resolveTranslateComponent.toString()});`,
    `const composeEffectiveTransform = (${composeEffectiveTransform.toString()});`,
    `const transformHasRotationOrSkew = (${transformHasRotationOrSkew.toString()});`,
    `const transformWrapsAsAffine2D = (${transformWrapsAsAffine2D.toString()});`,
    `const transitionCoversTransform = (${transitionCoversTransform.toString()});`,
    `const transformIsAnimated = (${transformIsAnimated.toString()});`,
    `const transformFreezes = (${transformFreezes.toString()});`,
    `const neutralizeTransformForFreeze = (${neutralizeTransformForFreeze.toString()});`,
  ].join("\n");
}

/**
 * Evaluate `callback(argument, transformFreezes)` with the predicate defined in
 * the same expression scope, so the page needs no global and no eval. The
 * predicate is passed as a parameter rather than referenced by name: a test
 * runner's module transform may rewrite a reference to an imported binding
 * inside the callback's source.
 * `__name` scopes esbuild's keep-names helper for source-run tsx callers.
 */
function evaluateWithFreezePredicate<Argument, Result>(
  page: Page,
  callback: (
    argument: Argument,
    freezes: typeof transformFreezes,
    neutralize: typeof neutralizeTransformForFreeze,
  ) => Result,
  argument: Argument,
): Promise<Result> {
  const expression = `((__name) => { ${frozenTransformPredicateSource()}\nreturn (${callback.toString()})(${JSON.stringify(argument)}, transformFreezes, neutralizeTransformForFreeze); })(function(target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch {} return target; })`;
  return page.evaluate(expression) as Promise<Result>;
}

/**
 * Limit neutralization to the ancestors of one live node, identified through a
 * private source-node registry (`globalThis[sourceNodeKey][index]`). An atomic
 * surface that owns its own subtree's transforms (a projective raster) must keep
 * every descendant transform and drop only the ancestor ones the renderer's
 * wrappers re-apply.
 */
export interface FrozenAncestorScope {
  sourceNodeKey: string;
  index: number;
}

/** Neutralize the frozen set in the main frame, run `work`, then restore. */
export async function withFrozenTransformsNeutralized<T>(
  page: Page,
  work: () => Promise<T>,
  ancestorsOf?: FrozenAncestorScope,
): Promise<T> {
  const key = privateCaptureKey("FrozenTransformNeutralizer");
  try {
    await evaluateWithFreezePredicate(
      page,
      ({ key, ancestorsOf }: { key: string; ancestorsOf: FrozenAncestorScope | null }, freezes, neutralize) => {
        const owners: (HTMLElement | SVGElement)[] = [];
        let candidates: Element[] = Array.from(document.querySelectorAll("*"));
        if (ancestorsOf != null) {
          const nodes = (globalThis as typeof globalThis & Record<string, unknown>)[ancestorsOf.sourceNodeKey] as
            Element[] | undefined;
          const source = nodes?.[ancestorsOf.index];
          candidates = [];
          for (let ancestor = source?.parentElement ?? null; ancestor != null; ancestor = ancestor.parentElement)
            candidates.push(ancestor);
        }
        // Decide every owner before writing any, so each decision reads the
        // same live styles the walk read.
        for (const element of candidates) {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
          if (!freezes(element, getComputedStyle(element))) continue;
          owners.push(element);
        }
        // The walker's own neutralization: an override animation that leaves
        // the base style (and so any declared transition) untouched.
        const restores = owners.map((element) => neutralize(element));
        (globalThis as typeof globalThis & Record<string, unknown>)[key] = restores;
        void document.documentElement.getBoundingClientRect();
        return restores.length;
      },
      { key, ancestorsOf: ancestorsOf ?? null },
    );
  } catch {
    // Neutralization is best effort: a failure leaves the live page as it
    // was, and `work` measures the transformed page as before.
  }
  try {
    return await work();
  } finally {
    await page
      .evaluate((key: string) => {
        const host = globalThis as typeof globalThis & Record<string, unknown>;
        const restores = host[key] as (() => void)[] | undefined;
        for (let index = (restores?.length ?? 0) - 1; index >= 0; index--) restores![index]();
        delete host[key];
        void document.documentElement.getBoundingClientRect();
      }, key)
      .catch(() => undefined);
  }
}
