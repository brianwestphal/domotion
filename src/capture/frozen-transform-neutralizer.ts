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
  frozenTransformSignature,
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
    `const frozenTransformSignature = (${frozenTransformSignature.toString()});`,
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
    isAnimated: typeof transformIsAnimated,
    signature: typeof frozenTransformSignature,
  ) => Result,
  argument: Argument,
): Promise<Result> {
  const expression = `((__name) => { ${frozenTransformPredicateSource()}\nreturn (${callback.toString()})(${JSON.stringify(argument)}, transformFreezes, neutralizeTransformForFreeze, transformIsAnimated, frozenTransformSignature); })(function(target, value) { try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch {} return target; })`;
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
          // A source inside a recursed frame is wrapped by that frame's
          // <iframe> and its ancestors too. The registry indexes exactly the
          // recursed documents, so it also names each document's owner.
          const frameOwnerOf = (doc: Document): Element | null => {
            if (doc === document) return null;
            for (const candidate of nodes ?? []) {
              if (candidate.localName !== "iframe") continue;
              try {
                if ((candidate as HTMLIFrameElement).contentDocument === doc) return candidate;
              } catch {
                /* An inaccessible frame cannot own an indexed document. */
              }
            }
            return null;
          };
          const nextAncestor = (element: Element): Element | null =>
            element.parentElement ?? frameOwnerOf(element.ownerDocument);
          candidates = [];
          for (let ancestor = source == null ? null : nextAncestor(source); ancestor != null;) {
            candidates.push(ancestor);
            ancestor = nextAncestor(ancestor);
          }
        }
        // Decide every owner before writing any, so each decision reads the
        // same live styles the walk read. A recursed frame's elements belong
        // to that frame's realm.
        for (const element of candidates) {
          const view = (element.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
          if (!(element instanceof view.HTMLElement || element instanceof view.SVGElement)) continue;
          if (!freezes(element, view.getComputedStyle(element))) continue;
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

export interface FrozenTransformOwner {
  sourceNodeIndex: number;
  signature: string;
}

interface FrozenTransformPlaneScope extends FrozenAncestorScope {
  owners: readonly FrozenTransformOwner[];
  sourceBox: { x: number; y: number; width: number; height: number };
}

interface FrozenTransformPlaneTransaction {
  stillNeutral(): boolean;
  restore(): boolean;
}

/** Sample a retained source Element in the exact plane used by the capture
 * walk. Its own frozen wrapper can participate as well as its ancestors. */
export async function withVerifiedFrozenTransformPlane<T>(
  page: Page,
  scope: FrozenTransformPlaneScope,
  work: () => Promise<T>,
): Promise<T> {
  const key = privateCaptureKey("VerifiedFrozenTransformPlane");
  let active = false;
  try {
    await evaluateWithFreezePredicate(
      page,
      ({ key, scope }, freezes, neutralize, isAnimated, signature) => {
        const host = globalThis as typeof globalThis & Record<string, unknown>;
        const nodes = host[scope.sourceNodeKey] as Element[] | undefined;
        const source = nodes?.[scope.index];
        if (source == null || !source.isConnected || source.getRootNode() !== document || scope.owners.length === 0)
          throw new Error("retained frozen-plane source is unavailable");

        const owners = (): HTMLElement[] => {
          let expected = scope.owners.length - 1;
          const verified: HTMLElement[] = [];
          for (let node: Element | null = source; node != null; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.assignedSlot != null || style.perspective !== "none" || style.transformStyle !== "flat")
              throw new Error("source path does not have a flat frozen transform plane");
            if ([style.transform, style.translate, style.rotate, style.scale].every((value) => value === "none"))
              continue;
            const proof = scope.owners[expected--];
            if (
              proof == null ||
              nodes?.[proof.sourceNodeIndex] !== node ||
              !(node instanceof HTMLElement) ||
              node.getClientRects().length !== 1 ||
              style.display === "inline" ||
              proof.signature !== signature(style) ||
              !freezes(node, style) ||
              isAnimated(node, style)
            )
              throw new Error("source transform ancestry differs from the captured frozen wrappers");
            verified.push(node);
          }
          if (expected !== -1) throw new Error("captured frozen wrapper is absent from the source path");
          return verified.reverse();
        };

        const matched = owners();
        const original = source.getBoundingClientRect();
        const ancestors: Element[] = [];
        for (let node: Element | null = source; node != null; node = node.parentElement) ancestors.push(node);
        const samePath = () => {
          let node: Element | null = source;
          for (const ancestor of ancestors) {
            if (node !== ancestor) return false;
            node = node.parentElement;
          }
          return (
            node == null &&
            source.isConnected &&
            source.getRootNode() === document &&
            host[scope.sourceNodeKey] === nodes &&
            nodes?.[scope.index] === source
          );
        };
        const attributes = matched.map((owner) => owner.getAttribute("style"));
        const animations = matched.map((owner) => owner.getAnimations());
        const matchesBox = (wanted: typeof scope.sourceBox, tolerance: number) => {
          if (source.getClientRects().length !== 1) return false;
          const live = source.getBoundingClientRect();
          return (
            Math.abs(live.x - wanted.x) <= tolerance &&
            Math.abs(live.y - wanted.y) <= tolerance &&
            Math.abs(live.width - wanted.width) <= tolerance &&
            Math.abs(live.height - wanted.height) <= tolerance
          );
        };
        let sourceChanged = false;
        const observation = new MutationObserver(() => {
          sourceChanged = true;
        });
        for (const ancestor of ancestors)
          observation.observe(ancestor, { childList: true, attributes: true, attributeFilter: ["slot", "open"] });
        const restores: Array<() => void> = [];
        const transaction: FrozenTransformPlaneTransaction = {
          stillNeutral() {
            return (
              !sourceChanged &&
              observation.takeRecords().length === 0 &&
              samePath() &&
              matched.every((owner) => {
                const style = getComputedStyle(owner);
                return (
                  style.transform === "matrix(1, 0, 0, 1, 0, 0)" &&
                  style.translate === "none" &&
                  style.rotate === "none" &&
                  style.scale === "none"
                );
              }) &&
              matchesBox(scope.sourceBox, 1 / 64)
            );
          },
          restore() {
            observation.disconnect();
            let success = true;
            for (const restore of restores.reverse()) {
              try {
                restore();
              } catch {
                success = false;
              }
            }
            return (
              success &&
              samePath() &&
              matchesBox(original, 0) &&
              owners().every((owner, index) => {
                const after = owner.getAnimations();
                return (
                  owner === matched[index] &&
                  owner.getAttribute("style") === attributes[index] &&
                  after.length === animations[index].length &&
                  after.every((animation, animationIndex) => animation === animations[index][animationIndex])
                );
              })
            );
          },
        };
        host[key] = transaction;
        for (const owner of matched) restores.push(neutralize(owner));
        if (!transaction.stillNeutral()) throw new Error("neutral source box does not match the captured local plane");
      },
      { key, scope },
    );
    active = true;
    const value = await work();
    if (
      !(await page.evaluate((key) => {
        const transaction = (globalThis as typeof globalThis & Record<string, unknown>)[key] as
          FrozenTransformPlaneTransaction | undefined;
        return transaction?.stillNeutral() === true;
      }, key))
    )
      throw new Error("neutral marker source changed during the protocol sample");
    return value;
  } finally {
    const restored = await page
      .evaluate(
        ({ key, active }) => {
          const host = globalThis as typeof globalThis & Record<string, unknown>;
          const transaction = host[key] as FrozenTransformPlaneTransaction | undefined;
          delete host[key];
          return transaction == null ? !active : transaction.restore();
        },
        { key, active },
      )
      .catch(() => false);
    if (!restored) throw new Error("restoration of the frozen marker source could not be verified");
  }
}
