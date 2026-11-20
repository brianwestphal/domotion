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
  parseAngleToDeg,
  resolveTranslateComponent,
  transformFreezes,
  transformHasRotationOrSkew,
  transformIsAnimated,
  transformWrapsAsAffine2D,
  transitionCoversTransform,
  TRANSFORM_PROPERTIES,
} from "./script/walker/transforms.js";

type SavedStyle = { element: HTMLElement | SVGElement; style: string | null };

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
  callback: (argument: Argument, freezes: typeof transformFreezes) => Result,
  argument: Argument,
): Promise<Result> {
  const expression = `((__name) => { ${frozenTransformPredicateSource()}\nreturn (${callback.toString()})(${JSON.stringify(argument)}, transformFreezes); })(function(target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch {} return target; })`;
  return page.evaluate(expression) as Promise<Result>;
}

/** Neutralize the frozen set in the main frame, run `work`, then restore. */
export async function withFrozenTransformsNeutralized<T>(page: Page, work: () => Promise<T>): Promise<T> {
  const key = privateCaptureKey("FrozenTransformNeutralizer");
  try {
    await evaluateWithFreezePredicate(
      page,
      (key: string, freezes) => {
        const saved: SavedStyle[] = [];
        // Decide every owner before writing any, so each decision reads the
        // same live styles the walk read.
        for (const element of Array.from(document.querySelectorAll("*"))) {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
          if (!freezes(element, getComputedStyle(element))) continue;
          saved.push({ element, style: element.getAttribute("style") });
        }
        for (const { element } of saved) {
          element.style.setProperty("transform", "translate(0)", "important");
          element.style.setProperty("translate", "none", "important");
          element.style.setProperty("rotate", "none", "important");
          element.style.setProperty("scale", "none", "important");
        }
        (globalThis as typeof globalThis & Record<string, unknown>)[key] = saved;
        void document.documentElement.getBoundingClientRect();
        return saved.length;
      },
      key,
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
        const saved = host[key] as SavedStyle[] | undefined;
        for (let index = (saved?.length ?? 0) - 1; index >= 0; index--) {
          const entry = saved![index];
          if (entry.style == null) {
            // Chromium serializes a CSSOM-mutated inline style into the
            // attribute lazily (Element::SynchronizeStyleAttributeInternal,
            // Chromium 7d859f27 core/dom/element.cc:12241).
            // Removing the attribute while that sync is pending lets the next
            // read re-materialize `style=""`, so empty the declaration and
            // read the attribute (which synchronizes it) before removing it.
            entry.element.style.cssText = "";
            void entry.element.getAttribute("style");
            entry.element.removeAttribute("style");
          } else entry.element.setAttribute("style", entry.style);
        }
        delete host[key];
        void document.documentElement.getBoundingClientRect();
      }, key)
      .catch(() => undefined);
  }
}
