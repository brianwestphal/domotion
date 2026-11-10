import type { Page } from "@playwright/test";
import { browserCallbackExpression } from "./evaluate-in-frame.js";
import { privateCaptureKey } from "./private-key.js";
import { withTimeout } from "../utils/with-timeout.js";

async function boundedVisibilityOperation<T>(operation: Promise<T>): Promise<T> {
  const expired = Symbol("snapshot visibility deadline");
  const result = await withTimeout(operation, 2000, expired);
  if (result === expired) throw new Error("snapshot visibility operation exceeded 2000ms");
  return result;
}

/** Private in-page owner; callers resolve source facts before start(). */
export interface SnapshotVisibilityState {
  start(): void;
  assertMutable(node: Element, property: string): void;
  paint(node: Element, visibility: string): boolean;
  paintTarget(): void;
  restore(): void;
}

/** Keep isolation's visibility changes immediate without stopping other CSS transitions. */
export async function suppressSnapshotVisibilityTransitions(
  page: Page,
  deferred = false,
): Promise<{ key: string; paintTarget(): Promise<void>; dispose(): Promise<void> }> {
  const marker = `data-${privateCaptureKey("SnapshotTransition").toLowerCase()}`;
  const key = privateCaptureKey("SnapshotVisibilityOwner");
  const preparation = page.evaluateHandle<SnapshotVisibilityState>(
    browserCallbackExpression((attribute: string) => {
      const NativeAnimation = Animation,
        NativeEffect = KeyframeEffect;
      const pause = Animation.prototype.pause,
        cancel = Animation.prototype.cancel;
      const setEffect = Object.getOwnPropertyDescriptor(Animation.prototype, "effect")?.set;
      const setTime = Object.getOwnPropertyDescriptor(Animation.prototype, "currentTime")?.set;
      const setFrames = KeyframeEffect.prototype.setKeyframes,
        updateTiming = KeyframeEffect.prototype.updateTiming;
      const getFrames = KeyframeEffect.prototype.getKeyframes,
        getTiming = AnimationEffect.prototype.getTiming;
      const getComputedTiming = AnimationEffect.prototype.getComputedTiming;
      const active = document
        .getAnimations()
        .filter(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "visibility" &&
            animation.playState !== "finished" &&
            animation.playState !== "idle",
        );
      // The frozen real-world DOM keeps these native APIs available. Never
      // borrow a foreign wrapper or resume author callbacks to create owners.
      if (
        active.length > 0 &&
        [
          Animation,
          KeyframeEffect,
          Animation.prototype.pause,
          Animation.prototype.cancel,
          KeyframeEffect.prototype.setKeyframes,
          KeyframeEffect.prototype.updateTiming,
          KeyframeEffect.prototype.getKeyframes,
          getTiming,
          getComputedTiming,
          setEffect,
          setTime,
        ].some(
          (value) => typeof value !== "function" || !Function.prototype.toString.call(value).includes("[native code]"),
        )
      )
        throw new Error("snapshot visibility native animation ownership unavailable");
      const owners = active.map((animation) => {
        const effect = animation.effect;
        if (
          !(effect instanceof KeyframeEffect) ||
          !(effect.target instanceof Element) ||
          effect.target.ownerDocument !== document ||
          effect.target.getRootNode() !== document ||
          effect.pseudoElement != null ||
          animation.timeline !== document.timeline ||
          animation.pending ||
          typeof animation.currentTime !== "number" ||
          !Number.isFinite(animation.currentTime) ||
          getComputedTiming.call(effect).progress == null
        )
          throw new Error("snapshot visibility transition owner/timeline is unsupported");
        const frames = getFrames.call(effect);
        if (
          frames.length !== 2 ||
          frames.some(
            (frame) =>
              typeof frame.visibility !== "string" ||
              Object.keys(frame).some(
                (name) => !["offset", "computedOffset", "easing", "composite", "visibility"].includes(name),
              ),
          )
        )
          throw new Error("snapshot visibility transition keyframe ownership is unsupported");
        return {
          animation,
          effect,
          node: effect.target,
          source: getComputedStyle(effect.target).visibility,
          frames: JSON.stringify(frames),
          timing: JSON.stringify(getTiming.call(effect)),
          playState: animation.playState,
          time: animation.currentTime,
          startTime: animation.startTime,
          guard: undefined as Animation | undefined,
          paint: undefined as Animation | undefined,
          owned: new Map<Animation, { effect: KeyframeEffect; frames: string; timing: string; time: number }>(),
        };
      });
      const properties = [
        "transition-property",
        "transition-duration",
        "transition-delay",
        "transition-timing-function",
        "transition-behavior",
      ];
      const saved: Array<{
        node: HTMLElement | SVGElement;
        properties: Array<{ name: string; value: string; priority: string }>;
        originalStyle: string | null;
        ownedStyle: string | null;
      }> = [];
      const marked: Element[] = [];
      const sheet = document.createElement("style");
      const rules: string[] = [];
      let started = false;
      let closed = false;
      const rememberOwned = (owner: (typeof owners)[number], animation: Animation, time: number) => {
        const effect = animation.effect as KeyframeEffect;
        owner.owned.set(animation, {
          effect,
          frames: JSON.stringify(getFrames.call(effect)),
          timing: JSON.stringify(getTiming.call(effect)),
          time,
        });
      };
      const verifyOwned = () => {
        for (const owner of owners)
          for (const [animation, fact] of owner.owned) {
            if (
              animation.effect !== fact.effect ||
              fact.effect.target !== owner.node ||
              animation.timeline !== document.timeline ||
              animation.playState !== "paused" ||
              animation.currentTime !== fact.time ||
              JSON.stringify(getFrames.call(fact.effect)) !== fact.frames ||
              JSON.stringify(getTiming.call(fact.effect)) !== fact.timing
            )
              throw new Error("snapshot visibility capture-owned animation changed");
          }
      };
      const verify = () => {
        for (const owner of owners) {
          if (
            !owner.node.isConnected ||
            owner.node.getRootNode() !== document ||
            owner.animation.effect !== owner.effect ||
            owner.animation.timeline !== document.timeline ||
            owner.animation.playState !== owner.playState ||
            owner.animation.startTime !== owner.startTime ||
            (owner.playState === "paused" && owner.animation.currentTime !== owner.time) ||
            JSON.stringify(getFrames.call(owner.effect)) !== owner.frames ||
            JSON.stringify(getTiming.call(owner.effect)) !== owner.timing
          )
            throw new Error("snapshot visibility source animation ownership changed");
        }
      };
      const restore = () => {
        closed = true;
        const failures: unknown[] = [];
        try {
          verifyOwned();
        } catch (error) {
          failures.push(error);
        }
        try {
          for (const node of marked) {
            void getComputedStyle(node, "::before").visibility;
            void getComputedStyle(node, "::after").visibility;
          }
          for (const { node } of saved) void getComputedStyle(node).visibility;
          sheet.remove();
          for (const { node, properties, originalStyle, ownedStyle } of saved) {
            try {
              // Preserve declaration order if this transaction still owns the
              // attribute, retaining unrelated source edits otherwise.
              if (node.getAttribute("style") === ownedStyle) {
                if (originalStyle == null) node.removeAttribute("style");
                else node.setAttribute("style", originalStyle);
                continue;
              }
              node.style.removeProperty("transition");
              for (const { name, value, priority } of properties) {
                if (value !== "") node.style.setProperty(name, value, priority);
              }
              if (originalStyle == null && node.style.length === 0) node.removeAttribute("style");
            } catch (error) {
              failures.push(error);
            }
          }
          for (const node of marked) node.removeAttribute(attribute);
          // Commit restored source values while ordinary guards still block
          // CSS retargeting. Only then cancel capture-owned objects, never the
          // original animation/effect or its cached native frame model.
          for (const owner of owners) void getComputedStyle(owner.node).visibility;
        } catch (error) {
          failures.push(error);
        } finally {
          for (const owner of owners) {
            for (const animation of [owner.paint, owner.guard]) {
              try {
                if (animation != null) cancel.call(animation);
              } catch (error) {
                failures.push(error);
              }
            }
          }
        }
        for (const owner of owners) void getComputedStyle(owner.node).visibility;
        verify();
        if (failures.length > 0) throw new Error("snapshot visibility source/owned cleanup failed");
      };
      const start = () => {
        if (closed) throw new Error("snapshot visibility owner is closed");
        if (started) return;
        started = true;
        try {
          verify();
          for (const owner of owners) {
            if (!owner.node.isConnected || owner.animation.effect !== owner.effect)
              throw new Error("snapshot visibility source owner changed before isolation");
            owner.guard = new NativeAnimation(
              new NativeEffect(owner.node, [{ visibility: owner.source }, { visibility: owner.source }], {
                duration: 1,
                fill: "both",
              }),
              document.timeline,
            );
            setTime!.call(owner.guard, 0);
            pause.call(owner.guard);
            rememberOwned(owner, owner.guard, 0);
            // Blink KeyframeEffect::Create(source) retains transition priority
            // AND the source CSS event delegate. Rebinding through a private base
            // Animation with an existing target clears that copied delegate.
            const clone = new NativeEffect(owner.effect);
            setFrames.call(clone, [{ visibility: owner.source }, { visibility: owner.source }]);
            updateTiming.call(clone, {
              duration: 1,
              delay: 0,
              endDelay: 0,
              iterations: 1,
              iterationStart: 0,
              direction: "normal",
              easing: "linear",
              fill: "both",
            });
            owner.paint = new NativeAnimation(new NativeEffect(owner.node, [], { duration: 1 }), document.timeline);
            setEffect!.call(owner.paint, clone);
            setTime!.call(owner.paint, 0.5);
            pause.call(owner.paint);
            rememberOwned(owner, owner.paint, 0.5);
          }
          for (const node of document.querySelectorAll("*")) {
            if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue;
            for (const pseudo of ["", "::before", "::after"]) {
              const computed = getComputedStyle(node, pseudo || null);
              if (pseudo !== "" && (computed.content === "none" || computed.content === "normal")) continue;
              if (pseudo === "" && owners.some((owner) => owner.node === node)) continue;
              if (!computed.transitionProperty.split(",").some((value) => /^(all|visibility)$/.test(value.trim())))
                continue;
              if (
                ![computed.transitionDuration, computed.transitionDelay].some((list) =>
                  list.split(",").some((value) => parseFloat(value) > 0),
                )
              )
                continue;

              // Blink CSSAnimations::CalculateTransitionUpdateForProperty uses the
              // last matching list entry. Retain every original entry and change
              // only visibility, whose transition-origin value outranks !important.
              const value = `${computed.transition}, visibility 0s linear 0s`;
              if (pseudo === "") {
                const entry = {
                  node,
                  originalStyle: node.getAttribute("style"),
                  ownedStyle: null as string | null,
                  properties: properties.map((name) => ({
                    name,
                    value: node.style.getPropertyValue(name),
                    priority: node.style.getPropertyPriority(name),
                  })),
                };
                saved.push(entry);
                node.style.setProperty("transition", value, "important");
                entry.ownedStyle = node.getAttribute("style");
              } else {
                if (!node.hasAttribute(attribute)) {
                  node.setAttribute(attribute, String(marked.length));
                  marked.push(node);
                }
                const boost = ":not(#domotion-snapshot-transition-boost)".repeat(4);
                rules.push(
                  `[${attribute}="${node.getAttribute(attribute)}"]${boost}${pseudo}{transition:${value}!important}`,
                );
              }
            }
          }
          if (rules.length > 0) {
            sheet.textContent = rules.join("\n");
            document.documentElement.append(sheet);
          }
          verifyOwned();
        } catch (error) {
          restore();
          throw error;
        }
      };
      return {
        start,
        assertMutable(node: Element, property: string) {
          if (closed) throw new Error("snapshot visibility owner is closed");
          if (property === "visibility") return;
          for (const animation of document.getAnimations()) {
            if (
              !(animation instanceof CSSTransition) ||
              animation.playState === "idle" ||
              animation.playState === "finished"
            )
              continue;
            const effect = animation.effect;
            if (!(effect instanceof KeyframeEffect) || effect.target !== node) continue;
            const affected = animation.transitionProperty;
            if (affected === property || affected.startsWith(`${property}-`))
              throw new Error(`snapshot isolation cannot mutate active authored ${affected} transition`);
          }
        },
        paint(node: Element, visibility: string) {
          if (closed) throw new Error("snapshot visibility owner is closed");
          verify();
          verifyOwned();
          const owner = owners.find((owner) => owner.node === node);
          if (owner == null) return false;
          if (!started || owner.paint == null || !(owner.paint.effect instanceof KeyframeEffect))
            throw new Error("snapshot visibility paint owner unavailable");
          // Configure only detached private clones; never rewrite source frames.
          // Callers still own the actual isolation declaration: the ordinary
          // guard must not replace their !important used-paint authority.
          const clone = new NativeEffect(owner.effect);
          setFrames.call(clone, [{ visibility }, { visibility }]);
          updateTiming.call(clone, {
            duration: 1,
            delay: 0,
            endDelay: 0,
            iterations: 1,
            iterationStart: 0,
            direction: "normal",
            easing: "linear",
            fill: "both",
          });
          setEffect!.call(owner.paint, clone);
          rememberOwned(owner, owner.paint, 0.5);
          return true;
        },
        paintTarget(this: SnapshotVisibilityState) {
          const target = document.querySelector("[data-domotion-snapshot-target]");
          for (const owner of owners)
            this.paint(
              owner.node,
              target != null && (owner.node === target || target.contains(owner.node)) ? "visible" : "hidden",
            );
        },
        restore,
      };
    }, marker),
  );
  let state: Awaited<typeof preparation>;
  try {
    state = await boundedVisibilityOperation(preparation);
  } catch (error) {
    // Preparation observes only: late replies own no DOM or animations.
    void preparation.then((handle) => handle.dispose()).catch(() => undefined);
    throw error;
  }
  try {
    await boundedVisibilityOperation(
      page.evaluate(
        ({ key, state }) => {
          (globalThis as typeof globalThis & Record<string, unknown>)[key] = state;
        },
        { key, state },
      ),
    );
    if (!deferred) await boundedVisibilityOperation(state.evaluate((value) => value.start()));
  } catch (error) {
    await boundedVisibilityOperation(state.evaluate((value) => value.restore())).catch(() => undefined);
    await boundedVisibilityOperation(state.dispose()).catch(() => undefined);
    await boundedVisibilityOperation(
      page.evaluate((key) => {
        delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
      }, key),
    ).catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    key,
    async paintTarget() {
      await boundedVisibilityOperation(state.evaluate((value) => value.paintTarget()));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await boundedVisibilityOperation(state.evaluate(({ restore }) => restore()));
      } finally {
        await boundedVisibilityOperation(
          page.evaluate((key) => {
            delete (globalThis as typeof globalThis & Record<string, unknown>)[key];
          }, key),
        ).catch(() => undefined);
        await boundedVisibilityOperation(state.dispose());
      }
    },
  };
}
