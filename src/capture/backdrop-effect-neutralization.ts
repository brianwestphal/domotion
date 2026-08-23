import type { Page } from "@playwright/test";

import type { CapturedElement } from "./types.js";

type BackdropRaster = NonNullable<CapturedElement["backdropFilterRaster"]>;
type BackdropEffectSpace = NonNullable<BackdropRaster["effectSpace"]>;
type AncestorPlan = BackdropEffectSpace["ancestors"][number];

export interface PreparedBackdropEffectSpace {
  status: "exact" | "unavailable";
  reason?: "missing-effect-space" | "missing-target" | "detached-ancestor";
  restore(): Promise<void>;
}

export function backdropNeutralizationDeclarations(
  neutralize: AncestorPlan["neutralize"],
): Array<[property: string, value: string]> {
  const declarations: Array<[string, string]> = [];
  for (const property of neutralize) {
    switch (property) {
      case "opacity": declarations.push(["opacity", "1"]); break;
      case "filter": declarations.push(["filter", "none"]); break;
      case "clip-path": declarations.push(["clip-path", "none"]); break;
      case "mask":
        declarations.push(["mask", "none"], ["-webkit-mask", "none"]);
        break;
      case "mix-blend-mode": declarations.push(["mix-blend-mode", "normal"]); break;
      case "rotate-skew":
        // Match walker/transforms.ts: the no-op transform retains the fixed
        // containing block while rotate/skew is moved to the SVG wrapper.
        declarations.push(
          ["transform", "translate(0)"],
          ["translate", "none"],
          ["rotate", "none"],
          ["scale", "none"],
        );
        break;
    }
  }
  return declarations;
}

const rootPreservingWillChange = (neutralize: AncestorPlan["neutralize"]): string[] =>
  neutralize.flatMap((property) => {
    switch (property) {
      case "opacity": return ["opacity"];
      case "filter": return ["filter"];
      case "clip-path": return ["clip-path"];
      case "mask": return ["mask"];
      case "mix-blend-mode": return ["mix-blend-mode"];
      case "rotate-skew": return [];
    }
  });

/**
 * Move one screenshot into the serialized Blink effect space and return an
 * idempotent restore handle. The page-global restore list deliberately owns
 * live Elements; no author-visible correlation attribute is added.
 */
export async function prepareBackdropEffectSpace(
  page: Page,
  raster: BackdropRaster,
): Promise<PreparedBackdropEffectSpace> {
  if (raster.effectSpace == null) {
    return { status: "unavailable", reason: "missing-effect-space", restore: async () => undefined };
  }
  const restoreToken = `dm2487-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const plans = raster.effectSpace.ancestors.map((plan) => ({
    depth: plan.depth,
    declarations: backdropNeutralizationDeclarations(plan.neutralize),
    preserveRoot: rootPreservingWillChange(plan.neutralize),
  }));
  let prepared: "exact" | "missing-target" | "detached-ancestor";
  try {
    prepared = await page.evaluate(({ targetToken, plans, restoreToken }) => {
    type RestoreItem = {
      element: HTMLElement;
      property: string;
      value: string;
      priority: string;
    };
    const host = globalThis as typeof globalThis & {
      __domotionBackdropEffectRestores?: Record<string, RestoreItem[]>;
    };
    host.__domotionBackdropEffectRestores ??= {};
    const restores: RestoreItem[] = [];
    host.__domotionBackdropEffectRestores[restoreToken] = restores;
    let target: HTMLElement | undefined;
    const candidates = document.querySelectorAll("[data-domotion-backdrop-raster]");
    for (let index = 0; index < candidates.length; index++) {
      const element = candidates[index];
      if (element.getAttribute("data-domotion-backdrop-raster") === targetToken) {
        target = element as HTMLElement;
        break;
      }
    }
    if (target == null) return "missing-target" as const;

    const saved = new WeakMap<HTMLElement, Set<string>>();
    for (const plan of plans) {
      let ancestor: HTMLElement | null = target;
      for (let depth = 0; depth < plan.depth; depth++) ancestor = ancestor?.parentElement ?? null;
      if (ancestor == null) return "detached-ancestor" as const;
      if (plan.preserveRoot.length > 0) {
        let properties = saved.get(ancestor);
        if (properties == null) {
          properties = new Set();
          saved.set(ancestor, properties);
        }
        if (!properties.has("will-change")) {
          properties.add("will-change");
          restores.push({
            element: ancestor,
            property: "will-change",
            value: ancestor.style.getPropertyValue("will-change"),
            priority: ancestor.style.getPropertyPriority("will-change"),
          });
        }
        const computed = getComputedStyle(ancestor).willChange;
        const tokens = new Set<string>();
        if (computed !== "auto" && computed !== "") {
          const parts = computed.split(",");
          for (let index = 0; index < parts.length; index++) {
            const token = parts[index].trim();
            if (token !== "") tokens.add(token);
          }
        }
        for (const token of plan.preserveRoot) tokens.add(token);
        ancestor.style.setProperty("will-change", Array.from(tokens).join(", "), "important");
      }
      for (const [property, value] of plan.declarations) {
        let properties = saved.get(ancestor);
        if (properties == null) {
          properties = new Set();
          saved.set(ancestor, properties);
        }
        if (!properties.has(property)) {
          properties.add(property);
          restores.push({
            element: ancestor,
            property,
            value: ancestor.style.getPropertyValue(property),
            priority: ancestor.style.getPropertyPriority(property),
          });
        }
        ancestor.style.setProperty(property, value, "important");
      }
    }
    return "exact" as const;
    }, { targetToken: raster.token ?? "", plans, restoreToken });
  } catch {
    prepared = "detached-ancestor";
  }

  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    await page.evaluate((token) => {
      type RestoreItem = {
        element: HTMLElement;
        property: string;
        value: string;
        priority: string;
      };
      const host = globalThis as typeof globalThis & {
        __domotionBackdropEffectRestores?: Record<string, RestoreItem[]>;
      };
      const items = host.__domotionBackdropEffectRestores?.[token] ?? [];
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.value === "") item.element.style.removeProperty(item.property);
        else item.element.style.setProperty(item.property, item.value, item.priority);
      }
      if (host.__domotionBackdropEffectRestores != null) {
        delete host.__domotionBackdropEffectRestores[token];
        if (Object.keys(host.__domotionBackdropEffectRestores).length === 0) {
          delete host.__domotionBackdropEffectRestores;
        }
      }
    }, restoreToken).catch(() => undefined);
  };

  return prepared === "exact"
    ? { status: "exact", restore }
    : { status: "unavailable", reason: prepared, restore };
}
