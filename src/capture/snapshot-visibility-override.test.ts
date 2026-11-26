/**
 * Unit coverage for the custom-element visibility override owned by the
 * in-page snapshot visibility state (DM-Q4J4JG). Isolation used to hide an
 * explicitly visible custom element by writing its `style` attribute, which
 * ran an observed-`style` attributeChangedCallback twice.
 *
 * The page callback is the real one: the test captures the expression that
 * `suppressDocumentVisibilityTransitions` hands to `evaluateHandle` and runs
 * it in a `vm` context whose Web Animations / cascade surface is a small model
 * of the Blink contract the override relies on (Chromium 7d859f27):
 *  - css/resolver/cascade_origin.h: kAnimation < author !important < kTransition.
 *  - animation/keyframe_effect.cc: KeyframeEffect::Create(source) copies the
 *    source's priority; setTarget leaves it alone.
 *  - animation/css/css_animations.cc: a CSS transition's effect has
 *    kTransitionPriority until cancelled (DowngradeToNormal), and
 *    CalculateTransitionActiveInterpolations drops transition-priority values
 *    for a property a default-priority animation also animates.
 * The real-browser contract is pinned by
 * tests/native-control-style-restoration.e2e.test.ts.
 */
import { createContext, runInContext } from "node:vm";
import type { JSHandle, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  suppressDocumentVisibilityTransitions,
  type SnapshotVisibilityState,
} from "./snapshot-visibility-transitions.js";

type Priority = "default" | "transition";
interface FakeElement {
  localName: string;
  attributes: Map<string, string>;
  /** Author-level computed visibility and whether it was declared !important. */
  author: { visibility: string; important: boolean };
  /** Author CSS animation that animates visibility (default priority). */
  cssVisibilityAnimation: boolean;
  animations: FakeAnimation[];
  isConnected: boolean;
  styleWrites: number;
}
interface FakeEffect {
  target: FakeElement | null;
  frames: Array<Record<string, string>>;
  priority: Priority;
}
interface FakeAnimation {
  effect: FakeEffect;
  cancelled: boolean;
  held: boolean;
}

interface Environment {
  state: SnapshotVisibilityState;
  element(localName: string, options?: Partial<Pick<FakeElement, "author" | "cssVisibilityAnimation">>): FakeElement;
  probes: { created: number; connected: number };
  /** Make `cancel` leave this animation registered, to model a failed cleanup. */
  sticky: Set<FakeAnimation>;
}

async function environment(options: { nativeApis?: boolean; transitionProbe?: boolean } = {}): Promise<Environment> {
  const nativeApis = options.nativeApis ?? true;
  const probes = { created: 0, connected: 0 };
  const sticky = new Set<FakeAnimation>();
  // V8 prints `[native code]` for any Proxy over a function, which is what a
  // genuine host binding looks like to Function.prototype.toString.
  const native = <T extends object>(value: T): T => (nativeApis ? new Proxy(value, {}) : value);

  class ElementBase {}
  class HTMLElementBase extends ElementBase {}
  class SVGElementBase extends ElementBase {}
  const visibleAnimations = (element: FakeElement) => element.animations.filter((animation) => !animation.cancelled);
  const computedVisibility = (element: FakeElement): string => {
    const effects = visibleAnimations(element)
      .filter((animation) => animation.held && animation.effect.frames.some((frame) => "visibility" in frame))
      .map((animation) => animation.effect);
    const defaults = effects.filter((effect) => effect.priority === "default");
    const transitions = effects.filter((effect) => effect.priority === "transition");
    // CalculateTransitionActiveInterpolations: a default-priority animation of
    // the same property erases transition-priority interpolations.
    const animatedByDefault = defaults.length > 0 || element.cssVisibilityAnimation;
    if (transitions.length > 0 && !animatedByDefault) return transitions.at(-1)!.frames[0].visibility;
    if (element.author.important) return element.author.visibility;
    if (defaults.length > 0) return defaults.at(-1)!.frames[0].visibility;
    return element.author.visibility;
  };

  class KeyframeEffectFake {
    // Accessor on the prototype (the native setter under test), not a field.
    declare target: FakeElement | null;
    frames: Array<Record<string, string>>;
    priority: Priority;
    constructor(source: FakeElement | KeyframeEffectFake | null, frames?: Array<Record<string, string>>) {
      if (source instanceof KeyframeEffectFake) {
        // KeyframeEffect::Create(source) copies target, model and priority.
        this.target = source.target;
        this.frames = source.frames.map((frame) => ({ ...frame }));
        this.priority = source.priority;
      } else {
        this.target = source;
        this.frames = frames ?? [];
        this.priority = "default";
      }
    }
  }
  const register = (animation: FakeAnimation) => {
    const target = animation.effect.target;
    if (target != null && !target.animations.includes(animation)) target.animations.push(animation);
  };
  const unregister = (animation: FakeAnimation) => {
    const target = animation.effect.target;
    if (target != null) target.animations = target.animations.filter((entry) => entry !== animation);
  };
  class AnimationFake implements FakeAnimation {
    // Accessor on the prototype (the native setter under test), not a field.
    declare effect: FakeEffect;
    cancelled = false;
    held = false;
    constructor(effect: FakeEffect) {
      this.effect = effect;
    }
  }
  class CSSTransitionFake extends AnimationFake {
    transitionProperty = "visibility";
  }
  const animationProto = AnimationFake.prototype as unknown as Record<string, unknown>;
  animationProto.pause = native(function (this: FakeAnimation) {
    this.held = true;
  });
  animationProto.cancel = native(function (this: FakeAnimation) {
    if (sticky.has(this)) return;
    this.cancelled = true;
    // Blink downgrades a cancelled transition's own effect (css_animations.cc).
    this.effect.priority = "default";
    unregister(this);
  });
  Object.defineProperty(AnimationFake.prototype, "currentTime", {
    set: native(function (this: FakeAnimation) {
      this.held = true;
    }),
  });
  Object.defineProperty(AnimationFake.prototype, "effect", {
    get(this: { _effect: FakeEffect }) {
      return this._effect;
    },
    set: native(function (this: FakeAnimation & { _effect?: FakeEffect }, effect: FakeEffect) {
      if (this._effect != null) unregister(this);
      this._effect = effect;
      register(this);
    }),
  });
  const effectProto = KeyframeEffectFake.prototype as unknown as Record<string, unknown>;
  effectProto.setKeyframes = native(function (this: FakeEffect, frames: Array<Record<string, string>>) {
    this.frames = frames;
  });
  effectProto.updateTiming = native(() => undefined);
  effectProto.getKeyframes = native(function (this: FakeEffect) {
    return this.frames;
  });
  Object.defineProperty(KeyframeEffectFake.prototype, "target", {
    get(this: { _target: FakeElement | null }) {
      return this._target;
    },
    set: native(function (this: { _target: FakeElement | null }, target: FakeElement | null) {
      this._target = target;
    }),
  });
  class AnimationEffectFake {}
  (AnimationEffectFake.prototype as unknown as Record<string, unknown>).getTiming = native(() => ({}));
  (AnimationEffectFake.prototype as unknown as Record<string, unknown>).getComputedTiming = native(() => ({}));
  (ElementBase.prototype as unknown as Record<string, unknown>).getAnimations = native(function (this: FakeElement) {
    return visibleAnimations(this);
  });

  const make = (localName: string, init: Partial<FakeElement> = {}): FakeElement => {
    const element = Object.create(
      localName === "svg" ? SVGElementBase.prototype : HTMLElementBase.prototype,
    ) as FakeElement & { hasAttribute(name: string): boolean };
    Object.assign(element, {
      localName,
      attributes: new Map<string, string>(),
      author: { visibility: "visible", important: false },
      cssVisibilityAnimation: false,
      animations: [],
      isConnected: true,
      styleWrites: 0,
      ...init,
    });
    element.hasAttribute = (name: string) => element.attributes.has(name);
    return element;
  };
  const documentElement = {
    append(probe: FakeElement & { transitionReady?: boolean }) {
      probes.connected++;
      probe.isConnected = true;
    },
  };
  const document = {
    documentElement,
    timeline: {},
    getAnimations: () => [],
    querySelectorAll: () => [],
    createElement(localName: string) {
      if (localName === "div") probes.created++;
      const probe = make(localName, { isConnected: false });
      let visibility = "visible";
      const style = {
        cssText: "",
        set visibility(value: string) {
          // A connected element whose cssText declares a visibility
          // transition starts a CSSTransition with kTransitionPriority.
          if (
            options.transitionProbe !== false &&
            probe.isConnected &&
            value !== visibility &&
            style.cssText.includes("transition:visibility")
          ) {
            const effect = new KeyframeEffectFake(probe, [{ visibility }, { visibility: value }]);
            effect.priority = "transition";
            new CSSTransitionFake(effect);
          }
          visibility = value;
        },
      };
      Object.assign(probe, {
        style,
        remove() {
          probes.connected--;
          probe.isConnected = false;
          for (const animation of [...probe.animations])
            (animationProto.cancel as (this: unknown) => void).call(animation);
        },
      });
      return probe;
    },
  };
  const context = createContext({
    Animation: native(AnimationFake),
    KeyframeEffect: native(KeyframeEffectFake),
    AnimationEffect: AnimationEffectFake,
    CSSTransition: CSSTransitionFake,
    Element: ElementBase,
    HTMLElement: HTMLElementBase,
    SVGElement: SVGElementBase,
    document,
    getComputedStyle: (element: FakeElement) => ({ visibility: computedVisibility(element) }),
  });

  let state: SnapshotVisibilityState | undefined;
  const page = {
    evaluateHandle: async (expression: string) => {
      state = runInContext(expression, context) as SnapshotVisibilityState;
      return {
        evaluate: async <R>(callback: (value: SnapshotVisibilityState) => R) => callback(state!),
        dispose: async () => undefined,
      } as unknown as JSHandle<SnapshotVisibilityState>;
    },
    evaluate: async () => undefined,
  } as unknown as Page;
  await suppressDocumentVisibilityTransitions(page, true);
  return {
    state: state!,
    element: (localName, init) => make(localName, init),
    probes,
    sticky,
  };
}

const node = (element: FakeElement) => element as unknown as Element;
const active = (element: FakeElement) => element.animations.filter((animation) => !animation.cancelled);

describe("snapshot visibility custom-element override (DM-Q4J4JG)", () => {
  it("leaves non-custom elements to the caller's inline write", async () => {
    const env = await environment();
    env.state.start();
    const div = env.element("div");
    const svg = env.element("svg");
    expect(env.state.override(node(div), "hidden")).toBe(false);
    expect(env.state.override(node(svg), "hidden")).toBe(false);
    expect(active(div)).toEqual([]);
    expect(env.probes.created).toBe(0);
  });

  it("takes a normal author value with one script animation and no probe", async () => {
    const env = await environment();
    env.state.start();
    const guard = env.element("x-guard");
    const builtIn = env.element("button");
    builtIn.attributes.set("is", "x-button");
    expect(env.state.override(node(guard), "hidden")).toBe(true);
    expect(env.state.override(node(builtIn), "hidden")).toBe(true);
    expect(active(guard).map((animation) => animation.effect.priority)).toEqual(["default"]);
    expect(env.probes.created).toBe(0);
    env.state.restore();
    expect(active(guard)).toEqual([]);
    expect(active(builtIn)).toEqual([]);
  });

  it("returns true without an effect when the element already computes to the value", async () => {
    const env = await environment();
    env.state.start();
    const guard = env.element("x-guard", { author: { visibility: "hidden", important: false } });
    expect(env.state.override(node(guard), "hidden")).toBe(true);
    expect(active(guard)).toEqual([]);
  });

  it("escalates an author !important to one transition-priority clone and removes the probe", async () => {
    const env = await environment();
    env.state.start();
    const first = env.element("x-guard", { author: { visibility: "visible", important: true } });
    const second = env.element("x-guard", { author: { visibility: "visible", important: true } });
    expect(env.state.override(node(first), "hidden")).toBe(true);
    expect(env.state.override(node(second), "hidden")).toBe(true);
    // The tier-1 animation was cancelled before the clone was attached, so the
    // default-priority erase rule cannot hide the clone.
    for (const guard of [first, second]) {
      expect(active(guard).map((animation) => animation.effect.priority)).toEqual(["transition"]);
      expect(guard.styleWrites).toBe(0);
    }
    // One probe, cloned once and reused; detached again before returning.
    expect(env.probes).toEqual({ created: 1, connected: 0 });
    env.state.restore();
    expect(active(first)).toEqual([]);
    expect(active(second)).toEqual([]);
  });

  it("reports false and leaves nothing behind when an author visibility animation erases transition priority", async () => {
    const env = await environment();
    env.state.start();
    const guard = env.element("x-guard", {
      author: { visibility: "visible", important: true },
      cssVisibilityAnimation: true,
    });
    expect(env.state.override(node(guard), "hidden")).toBe(false);
    expect(active(guard)).toEqual([]);
    expect(env.probes.connected).toBe(0);
  });

  it("reports false when the probe yields no transition", async () => {
    const env = await environment({ transitionProbe: false });
    env.state.start();
    const guard = env.element("x-guard", { author: { visibility: "visible", important: true } });
    expect(env.state.override(node(guard), "hidden")).toBe(false);
    expect(active(guard)).toEqual([]);
    expect(env.probes.connected).toBe(0);
  });

  it("reports false instead of borrowing non-native animation APIs", async () => {
    const env = await environment({ nativeApis: false });
    env.state.start();
    const guard = env.element("x-guard");
    expect(env.state.override(node(guard), "hidden")).toBe(false);
    expect(active(guard)).toEqual([]);
  });

  it("refuses to run before start and after restore", async () => {
    const env = await environment();
    const guard = env.element("x-guard");
    expect(() => env.state.override(node(guard), "hidden")).toThrow("has not started");
    env.state.start();
    env.state.restore();
    expect(() => env.state.override(node(guard), "hidden")).toThrow("is closed");
  });

  it("fails restore when an override survives cancellation", async () => {
    const env = await environment();
    env.state.start();
    const guard = env.element("x-guard");
    expect(env.state.override(node(guard), "hidden")).toBe(true);
    env.sticky.add(active(guard)[0]);
    expect(() => env.state.restore()).toThrow("cleanup failed");
  });
});
