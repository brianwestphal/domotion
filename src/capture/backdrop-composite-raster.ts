import type { Page } from "@playwright/test";
import sharp from "sharp";

import { clipRectForScreenshot } from "./clip-rect.js";
import type {
  BackdropCompositeConsumedEffect,
  CapturedElement,
  CapturedBackdropCompositeRaster,
} from "./types.js";
import type { BackdropEffectNeutralization } from "./backdrop-effect-space.js";

type BackdropRaster = NonNullable<CapturedElement["backdropFilterRaster"]>;

export interface BackdropCompositeTarget {
  element: CapturedElement;
  raster: BackdropRaster;
  selector: string;
}

export interface BackdropRootCompositeJob {
  root: CapturedElement;
  targets: BackdropCompositeTarget[];
  rootDepth: number;
  consumedEffects: BackdropCompositeConsumedEffect[];
  neutralizedEffects: BackdropEffectNeutralization[];
}

const activeFilter = (element: CapturedElement): boolean =>
  element.styles.filter != null && element.styles.filter !== "" && element.styles.filter !== "none";

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/**
 * Resolve each ordinary backdrop owner to the captured element which owns its
 * nearest atomic Blink Backdrop Root.  Filter-only and clip-only roots already
 * have exact target-boundary capture; opacity, mask, and blend require the
 * entire root to remain one composited surface.
 */
export function planBackdropRootComposites(tree: CapturedElement[]): BackdropRootCompositeJob[] {
  const parents = new Map<CapturedElement, CapturedElement>();
  const elements: CapturedElement[] = [];
  const visit = (element: CapturedElement): void => {
    elements.push(element);
    for (const child of element.children ?? []) {
      parents.set(child, element);
      visit(child);
    }
  };
  for (const element of tree) visit(element);

  const jobs = new Map<CapturedElement, BackdropRootCompositeJob>();
  for (const element of elements) {
    const raster = element.backdropFilterRaster;
    const effectSpace = raster?.effectSpace;
    if (raster?.token == null || effectSpace?.nearestRoot.kind !== "element") continue;
    const reasons = effectSpace.nearestRoot.reasons;
    if (!reasons.some((reason) => reason === "opacity" || reason === "mask" || reason === "mix-blend-mode")) continue;
    let root: CapturedElement | undefined = element;
    for (let depth = 0; depth < effectSpace.nearestRoot.depth; depth++) root = root == null ? undefined : parents.get(root);
    if (root == null) continue;
    const rootPlan = effectSpace.ancestors.find((ancestor) => ancestor.depth === effectSpace.nearestRoot.depth);
    const neutralized = (rootPlan?.neutralize ?? []).filter((effect) => effect !== "mask" && effect !== "clip-path");
    const consumed: BackdropCompositeConsumedEffect[] = [];
    if (reasons.includes("mask")) consumed.push("mask");
    if (reasons.includes("clip-path")) consumed.push("clip-path");
    if (reasons.includes("mix-blend-mode")) consumed.push("mix-blend-mode");
    const target = { element, raster, selector: raster.selector ?? element.tag };
    const existing = jobs.get(root);
    if (existing == null) {
      jobs.set(root, {
        root,
        targets: [target],
        rootDepth: effectSpace.nearestRoot.depth,
        consumedEffects: unique(consumed),
        neutralizedEffects: unique(neutralized),
      });
    } else {
      existing.targets.push(target);
      existing.consumedEffects = unique([...existing.consumedEffects, ...consumed]);
      existing.neutralizedEffects = unique([...existing.neutralizedEffects, ...neutralized]);
    }
  }
  return [...jobs.values()];
}

export function targetNeedsAtomicFilterComposite(target: BackdropCompositeTarget): boolean {
  return activeFilter(target.element);
}

interface PreparedRoot {
  status: "exact" | "unavailable";
  rect?: { x: number; y: number; width: number; height: number };
  reason?: "missing-target" | "detached-root" | "empty-root";
  restore(): Promise<void>;
}

interface MaskCalibration {
  clip: { x: number; y: number; width: number; height: number };
  source: Buffer;
  base: Buffer;
}

async function captureMaskCalibration(
  page: Page,
  job: BackdropRootCompositeJob,
  viewport: { x: number; y: number; width: number; height: number },
): Promise<MaskCalibration | null> {
  if (!job.consumedEffects.some((effect) => effect === "mask" || effect === "mix-blend-mode")
    || job.neutralizedEffects.length !== 0) return null;
  const token = job.targets[0]?.raster.token ?? "";
  const facts = await page.evaluate(({ token, rootDepth }) => {
    let target: HTMLElement | null = null;
    const candidates = document.querySelectorAll<HTMLElement>("[data-domotion-backdrop-raster]");
    for (let index = 0; index < candidates.length; index++) {
      if (candidates[index].getAttribute("data-domotion-backdrop-raster") === token) {
        target = candidates[index];
        break;
      }
    }
    if (target == null) return null;
    let root: HTMLElement | null = target;
    for (let depth = 0; depth < rootDepth; depth++) root = root?.parentElement ?? null;
    if (root == null) return null;
    const rect = root.getBoundingClientRect();
    return {
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      visibility: root.style.getPropertyValue("visibility"),
      priority: root.style.getPropertyPriority("visibility"),
    };
  }, { token, rootDepth: job.rootDepth }).catch(() => null);
  if (facts == null || !(facts.rect.width > 0 && facts.rect.height > 0)) return null;
  const clip = clipRectForScreenshot(facts.rect, viewport);
  try {
    const source = Buffer.from(await page.screenshot({ clip, omitBackground: true, type: "png" }));
    await page.evaluate(({ token, rootDepth }) => {
      let target: HTMLElement | null = null;
      const candidates = document.querySelectorAll<HTMLElement>("[data-domotion-backdrop-raster]");
      for (let index = 0; index < candidates.length; index++) {
        if (candidates[index].getAttribute("data-domotion-backdrop-raster") === token) {
          target = candidates[index];
          break;
        }
      }
      let root: HTMLElement | null = target;
      for (let depth = 0; depth < rootDepth; depth++) root = root?.parentElement ?? null;
      root?.style.setProperty("visibility", "hidden", "important");
    }, { token, rootDepth: job.rootDepth });
    const base = Buffer.from(await page.screenshot({ clip, omitBackground: true, type: "png" }));
    return { clip, source, base };
  } catch {
    return null;
  } finally {
    await page.evaluate(({ token, rootDepth, visibility, priority }) => {
      let target: HTMLElement | null = null;
      const candidates = document.querySelectorAll<HTMLElement>("[data-domotion-backdrop-raster]");
      for (let index = 0; index < candidates.length; index++) {
        if (candidates[index].getAttribute("data-domotion-backdrop-raster") === token) {
          target = candidates[index];
          break;
        }
      }
      let root: HTMLElement | null = target;
      for (let depth = 0; depth < rootDepth; depth++) root = root?.parentElement ?? null;
      if (root == null) return;
      if (visibility === "") root.style.removeProperty("visibility");
      else root.style.setProperty("visibility", visibility, priority);
    }, { token, rootDepth: job.rootDepth, visibility: facts.visibility, priority: facts.priority }).catch(() => undefined);
  }
}

async function calibrateTransparentComposite(
  alphaPng: Buffer,
  sourcePng: Buffer,
  basePng: Buffer,
  preserveCapturedCoverage: boolean,
): Promise<Buffer> {
  const [alpha, source, base] = await Promise.all([
    sharp(alphaPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(sourcePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(basePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (alpha.info.width !== source.info.width || alpha.info.height !== source.info.height
    || alpha.info.width !== base.info.width || alpha.info.height !== base.info.height) return alphaPng;
  const data = Buffer.alloc(alpha.data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    let opacity = preserveCapturedCoverage ? alpha.data[offset + 3] : 0;
    for (let channel = 0; channel < 3; channel++) {
      const backdrop = base.data[offset + channel];
      const result = source.data[offset + channel];
      if (result > backdrop && backdrop < 255) {
        opacity = Math.max(opacity, Math.ceil((result - backdrop) * 255 / (255 - backdrop)));
      } else if (result < backdrop && backdrop > 0) {
        opacity = Math.max(opacity, Math.ceil((backdrop - result) * 255 / backdrop));
      }
    }
    opacity = Math.min(255, opacity);
    data[offset + 3] = opacity;
    if (opacity === 0) continue;
    for (let channel = 0; channel < 3; channel++) {
      const backdrop = base.data[offset + channel];
      const result = source.data[offset + channel];
      let foreground = Math.round((result * 255 - backdrop * (255 - opacity)) / opacity);
      foreground = Math.max(0, Math.min(255, foreground));
      data[offset + channel] = foreground;
    }
  }
  return sharp(data, { raw: { width: alpha.info.width, height: alpha.info.height, channels: 4 } }).png().toBuffer();
}

async function prepareIsolatedBackdropRoot(
  page: Page,
  job: BackdropRootCompositeJob,
): Promise<PreparedRoot> {
  const token = job.targets[0]?.raster.token ?? "";
  const restoreToken = `dm2495-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const prepared = await page.evaluate(({ token, rootDepth, neutralizedEffects, restoreToken }) => {
    type RestoreItem = { element: HTMLElement; property: string; value: string; priority: string };
    const host = globalThis as typeof globalThis & {
      __domotionBackdropCompositeRestores?: Record<string, RestoreItem[]>;
    };
    host.__domotionBackdropCompositeRestores ??= {};
    const restores: RestoreItem[] = [];
    host.__domotionBackdropCompositeRestores[restoreToken] = restores;
    let target: HTMLElement | null = null;
    const candidates = document.querySelectorAll<HTMLElement>("[data-domotion-backdrop-raster]");
    for (let index = 0; index < candidates.length; index++) {
      if (candidates[index].getAttribute("data-domotion-backdrop-raster") === token) {
        target = candidates[index];
        break;
      }
    }
    if (target == null) return { status: "missing-target" as const };
    let root: HTMLElement | null = target;
    for (let depth = 0; depth < rootDepth; depth++) root = root?.parentElement ?? null;
    if (root == null) return { status: "detached-root" as const };

    const rootColor = getComputedStyle(root).color;
    const rootFill = getComputedStyle(root).fill;
    const rootStroke = getComputedStyle(root).stroke;
    const ancestors: HTMLElement[] = [];
    let ancestor = root.parentElement;
    while (ancestor != null) {
      ancestors.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    const elements = document.querySelectorAll<HTMLElement>("*");
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (element === root || root.contains(element)) continue;
      if (ancestors.indexOf(element) >= 0) {
        const properties = ["background", "border-color", "box-shadow", "outline", "text-shadow", "color"];
        const values = ["transparent", "transparent", "none", "none", "none", "transparent"];
        for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
          const property = properties[propertyIndex];
          restores.push({
            element,
            property,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          });
          element.style.setProperty(property, values[propertyIndex], "important");
        }
      } else {
        const property = "visibility";
        restores.push({
          element,
          property,
          value: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
        });
        element.style.setProperty(property, "hidden", "important");
      }
    }
    const inheritedProperties = ["color", "fill", "stroke"];
    const inheritedValues = [rootColor, rootFill, rootStroke];
    for (let index = 0; index < inheritedProperties.length; index++) {
      const property = inheritedProperties[index];
      restores.push({
        element: root,
        property,
        value: root.style.getPropertyValue(property),
        priority: root.style.getPropertyPriority(property),
      });
      root.style.setProperty(property, inheritedValues[index], "important");
    }

    const willChange = getComputedStyle(root).willChange;
    restores.push({
      element: root,
      property: "will-change",
      value: root.style.getPropertyValue("will-change"),
      priority: root.style.getPropertyPriority("will-change"),
    });
    const willChangeTokens: string[] = [];
    if (willChange !== "auto" && willChange !== "") {
      const parts = willChange.split(",");
      for (let index = 0; index < parts.length; index++) {
        const value = parts[index].trim();
        if (value !== "" && willChangeTokens.indexOf(value) < 0) willChangeTokens.push(value);
      }
    }
    for (let index = 0; index < neutralizedEffects.length; index++) {
      const effect = neutralizedEffects[index];
      const property = effect === "rotate-skew" ? "transform" : effect;
      if (willChangeTokens.indexOf(property) < 0) willChangeTokens.push(property);
    }
    if (willChangeTokens.length > 0) root.style.setProperty("will-change", willChangeTokens.join(", "), "important");

    for (let index = 0; index < neutralizedEffects.length; index++) {
      const effect = neutralizedEffects[index];
      const properties: string[] = [];
      const values: string[] = [];
      if (effect === "opacity") { properties.push("opacity"); values.push("1"); }
      else if (effect === "filter") { properties.push("filter"); values.push("none"); }
      else if (effect === "mix-blend-mode") { properties.push("mix-blend-mode"); values.push("normal"); }
      else if (effect === "rotate-skew") {
        properties.push("transform", "translate", "rotate", "scale");
        values.push("translate(0)", "none", "none", "none");
      }
      for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
        const property = properties[propertyIndex];
        restores.push({
          element: root,
          property,
          value: root.style.getPropertyValue(property),
          priority: root.style.getPropertyPriority(property),
        });
        root.style.setProperty(property, values[propertyIndex], "important");
      }
    }
    const rect = root.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return { status: "empty-root" as const };
    return { status: "exact" as const, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
  }, { token, rootDepth: job.rootDepth, neutralizedEffects: job.neutralizedEffects, restoreToken }).catch(() => ({ status: "detached-root" as const }));

  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    await page.evaluate((token) => {
      type RestoreItem = { element: HTMLElement; property: string; value: string; priority: string };
      const host = globalThis as typeof globalThis & {
        __domotionBackdropCompositeRestores?: Record<string, RestoreItem[]>;
      };
      const items = host.__domotionBackdropCompositeRestores?.[token] ?? [];
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.value === "") item.element.style.removeProperty(item.property);
        else item.element.style.setProperty(item.property, item.value, item.priority);
      }
      if (host.__domotionBackdropCompositeRestores != null) {
        delete host.__domotionBackdropCompositeRestores[token];
        if (Object.keys(host.__domotionBackdropCompositeRestores).length === 0) delete host.__domotionBackdropCompositeRestores;
      }
    }, restoreToken).catch(() => undefined);
  };
  return prepared.status === "exact"
    ? { status: "exact", rect: prepared.rect, restore }
    : { status: "unavailable", reason: prepared.status, restore };
}

/** Capture one transparent pre-parent-effect surface per atomic Backdrop Root. */
export async function materializeBackdropRootComposites(
  page: Page,
  jobs: BackdropRootCompositeJob[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<Set<BackdropRaster>> {
  const covered = new Set<BackdropRaster>();
  for (const job of jobs) {
    const maskCalibration = await captureMaskCalibration(page, job, viewport);
    const prepared = await prepareIsolatedBackdropRoot(page, job);
    try {
      if (prepared.status !== "exact" || prepared.rect == null) continue;
      const clip = clipRectForScreenshot(prepared.rect, viewport);
      const captured = Buffer.from(await page.screenshot({ clip, omitBackground: true, type: "png" }));
      const png = maskCalibration == null
        ? captured
        : await calibrateTransparentComposite(
          captured,
          maskCalibration.source,
          maskCalibration.base,
          job.consumedEffects.includes("mask"),
        );
      const composite: CapturedBackdropCompositeRaster = {
        x: clip.x - viewport.x,
        y: clip.y - viewport.y,
        width: clip.width,
        height: clip.height,
        dataUri: `data:image/png;base64,${png.toString("base64")}`,
        source: "chromium-isolated-backdrop-root-v1",
        consumedEffects: job.consumedEffects,
        neutralizedEffects: job.neutralizedEffects,
        ownerCount: job.targets.length,
        screenshotPasses: maskCalibration == null ? 1 : 3,
      };
      job.root.backdropCompositeRaster = composite;
      for (const target of job.targets) covered.add(target.raster);
    } catch {
      // The existing target-boundary path remains the explicit fallback.
    } finally {
      await prepared.restore();
    }
  }
  return covered;
}
