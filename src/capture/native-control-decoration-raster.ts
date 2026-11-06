/**
 * Exact Chromium isolation for partial form-control decorations.
 *
 * Closed UA-shadow parts are retained by the CDP pre-pass and validated again
 * immediately before one page-wide transparent screenshot. A styled select's
 * arrow has no shadow node, so its CSS box/text paint is neutralized without
 * changing the author-background activation which makes Blink dispatch
 * `PaintMenuListButton`. Every emitted crop therefore contains decoration
 * pixels only; the structural renderer continues to own the host and text.
 */

import type { Page } from "@playwright/test";
import sharp from "sharp";
import { createPageRegistry } from "./page-registry.js";
import type { CapturedElement, CaptureWarning } from "./types.js";
import {
  cropNativeControlRgba,
  nativeControlAlphaStats,
  nativeControlPixelCrop,
  planNativeControlClip,
  type NativeControlViewport,
} from "./native-control-raster.js";

type DecorationRaster = NonNullable<CapturedElement["nativeControlDecorationRaster"]>;

interface DecorationTarget {
  element: CapturedElement;
  raster: DecorationRaster;
}

interface IsolationFact {
  connected: boolean;
  fingerprintMatches: boolean;
  reason?: string;
}

const FEATURE = "native-control-decoration-raster";

export function nativeDecorationRectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** A one-pixel transparent guard must surround an unclipped partial crop. */
export function nativeDecorationTouchesBoundary(
  rgba: Uint8Array,
  width: number,
  height: number,
  edges: { left: boolean; top: boolean; right: boolean; bottom: boolean },
): boolean {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) return true;
  const alpha = (x: number, y: number): number => rgba[(y * width + x) * 4 + 3];
  if (edges.top) for (let x = 0; x < width; x++) if (alpha(x, 0) !== 0) return true;
  if (edges.bottom) for (let x = 0; x < width; x++) if (alpha(x, height - 1) !== 0) return true;
  if (edges.left) for (let y = 0; y < height; y++) if (alpha(0, y) !== 0) return true;
  if (edges.right) for (let y = 0; y < height; y++) if (alpha(width - 1, y) !== 0) return true;
  return false;
}

function collectTargets(tree: CapturedElement[]): { all: DecorationTarget[]; materialized: DecorationTarget[] } {
  const all: DecorationTarget[] = [];
  const materialized: DecorationTarget[] = [];
  const visit = (nodes: CapturedElement[], projectiveOwner: boolean): void => {
    for (const element of nodes) {
      const ownedByProjectiveRaster = projectiveOwner || element.transformSubtreeRaster != null;
      if (element.nativeControlDecorationRaster != null) {
        const target = { element, raster: element.nativeControlDecorationRaster };
        all.push(target);
        if (!ownedByProjectiveRaster) materialized.push(target);
      }
      visit(element.children ?? [], ownedByProjectiveRaster);
    }
  };
  visit(tree, false);
  return { all, materialized };
}

function warn(warnings: CaptureWarning[], target: DecorationTarget, reason: string): void {
  const selector =
    target.raster.selector ??
    `${target.element.tag}${target.element.styles.inputType == null ? "" : `[type=${target.element.styles.inputType}]`}`;
  if (warnings.some((entry) => entry.feature === FEATURE && entry.selector === selector)) return;
  warnings.push({
    selector,
    feature: FEATURE,
    detail: `required Chromium native/closed-shadow decoration unavailable (${reason}); sampled SVG decoration is suppressed`,
  });
}

async function takeIsolationFrame(
  page: Page,
  viewport: NativeControlViewport,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  try {
    const png = await page.screenshot({
      clip: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
      omitBackground: true,
      type: "png",
    });
    const decoded = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.channels !== 4 || decoded.info.width <= 0 || decoded.info.height <= 0) return null;
    return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
  } catch {
    return null;
  }
}

type DecorationPart = NonNullable<DecorationRaster["parts"]>[number];

/** Serializable per-owner facts handed to the page-evaluated isolation and restore passes. */
interface IsolationRow {
  index: number | undefined;
  selectArrow: boolean;
  exactPartBox: boolean;
  parts: DecorationPart[] | undefined;
  hostRect: { left: number; top: number; width: number; height: number };
}

interface IsolationPageArgs {
  sourceNodeKey: string;
  decorationNodeKey: string;
  restoreKey: string;
  rows: IsolationRow[];
}

interface RestorePageArgs {
  key: string;
  sourceNodeKey: string;
  decorationNodeKey: string;
  rows: IsolationRow[];
}

type IsolationFrame = Awaited<ReturnType<typeof takeIsolationFrame>>;
type DecorationClipPlan = NonNullable<ReturnType<typeof planNativeControlClip>>;

/** Materialize one transparent atlas for every partial decoration owner. */
export async function rasterizeNativeControlDecorations(
  page: Page,
  tree: CapturedElement[],
  viewport: NativeControlViewport,
  options: {
    warnings: CaptureWarning[];
    sourceNodeKey?: string;
    decorationNodeKey?: string;
  },
): Promise<void> {
  const { all, materialized } = collectTargets(tree);
  if (all.length === 0) return;

  const active = resolveActiveTargets(materialized, options.warnings);
  if (active.length === 0) {
    clearPrivateDecorationFields(all);
    return;
  }
  if (options.sourceNodeKey == null || options.decorationNodeKey == null) {
    for (const target of active) warn(options.warnings, target, "live-node registry unavailable");
    clearPrivateDecorationFields(all);
    return;
  }

  const { plans, blocked } = planDecorationClips(active, viewport, options.warnings);
  const { facts, isolated } = await captureIsolatedDecorations(page, viewport, active, {
    sourceNodeKey: options.sourceNodeKey,
    decorationNodeKey: options.decorationNodeKey,
  });

  try {
    for (let index = 0; index < active.length; index++) {
      const plan = plans[index];
      if (plan == null || blocked.has(index)) continue;
      await materializeDecorationCrop(active[index], plan, facts[index], isolated, viewport, options.warnings);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "decoration PNG encoding failed";
    for (const target of active) {
      if (target.raster.dataUri == null && target.raster.empty !== true) warn(options.warnings, target, reason);
    }
  } finally {
    clearPrivateDecorationFields(all);
  }
}

/** Strip the private CDP pre-pass correlation fields once the post-pass is done. */
function clearPrivateDecorationFields(all: DecorationTarget[]): void {
  for (const { raster } of all) {
    delete raster.sourceNodeIndex;
    delete raster.selector;
    delete raster.selectArrow;
    delete raster.exactPartBox;
    delete raster.parts;
    delete raster.unavailableReason;
  }
}

/** Owners that still need a crop; explicit discovery failures warn and drop out. */
function resolveActiveTargets(materialized: DecorationTarget[], warnings: CaptureWarning[]): DecorationTarget[] {
  return materialized.filter((target) => {
    if (target.raster.unavailableReason != null) {
      warn(warnings, target, target.raster.unavailableReason);
      return false;
    }
    return target.raster.empty !== true;
  });
}

/**
 * Viewport clip plan per owner, plus the indexes that cannot be cropped: an
 * invalid/fully clipped rectangle, or an output that overlaps another owner's
 * (one shared isolation atlas cannot separate them).
 */
function planDecorationClips(
  active: DecorationTarget[],
  viewport: NativeControlViewport,
  warnings: CaptureWarning[],
): { plans: (DecorationClipPlan | null)[]; blocked: Set<number> } {
  const plans = active.map(({ raster }) => planNativeControlClip(raster, viewport));
  const blocked = new Set<number>();
  for (let index = 0; index < active.length; index++) {
    if (plans[index] == null) {
      warn(warnings, active[index], "invalid or fully viewport-clipped decoration rectangle");
      blocked.add(index);
    }
    for (let other = 0; other < index; other++) {
      if (
        plans[index] != null &&
        plans[other] != null &&
        nativeDecorationRectsOverlap(plans[index]!.output, plans[other]!.output)
      ) {
        blocked.add(index);
        blocked.add(other);
      }
    }
  }
  for (const index of blocked) {
    if (plans[index] != null)
      warn(warnings, active[index], "overlapping partial decoration owners cannot share one isolation atlas");
  }
  return { plans, blocked };
}

function buildIsolationRows(active: DecorationTarget[], viewport: NativeControlViewport): IsolationRow[] {
  return active.map(({ element, raster }) => ({
    index: raster.sourceNodeIndex,
    selectArrow: raster.selectArrow === true,
    exactPartBox: raster.exactPartBox === true,
    parts: raster.parts,
    hostRect: {
      left: element.x + viewport.x,
      top: element.y + viewport.y,
      width: element.width,
      height: element.height,
    },
  }));
}

/**
 * Isolate every owner's decoration in the live page, take one transparent
 * screenshot, then restore and verify the page. A failed restore invalidates
 * every fingerprint so no crop is trusted.
 */
async function captureIsolatedDecorations(
  page: Page,
  viewport: NativeControlViewport,
  active: DecorationTarget[],
  keys: { sourceNodeKey: string; decorationNodeKey: string },
): Promise<{ facts: IsolationFact[]; isolated: IsolationFrame }> {
  const restoreRegistry = createPageRegistry<unknown>(page, "DecorationRestore");
  const restoreKey = restoreRegistry.key;
  let facts: IsolationFact[] = active.map(() => ({ connected: false, fingerprintMatches: false }));
  let isolated: IsolationFrame = null;
  const isolationRows = buildIsolationRows(active, viewport);
  try {
    await restoreRegistry.tag(page, () => ({ entries: [], activeElement: document.activeElement }));
    facts = await page.evaluate(isolateDecorationsInPage, {
      sourceNodeKey: keys.sourceNodeKey,
      decorationNodeKey: keys.decorationNodeKey,
      restoreKey,
      rows: isolationRows,
    });
    isolated = await takeIsolationFrame(page, viewport);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "isolation preparation failed";
    facts = active.map(() => ({ connected: false, fingerprintMatches: false, reason }));
  } finally {
    const restored = await page
      .evaluate(restoreDecorationIsolationInPage, {
        key: restoreKey,
        sourceNodeKey: keys.sourceNodeKey,
        decorationNodeKey: keys.decorationNodeKey,
        rows: isolationRows,
      })
      .catch((error) => ({
        ok: false,
        reason:
          error instanceof Error ? `restore verification failed: ${error.message}` : "restore verification failed",
      }));
    await restoreRegistry.dispose();
    if (!restored.ok) {
      facts = facts.map((fact) => ({
        ...fact,
        fingerprintMatches: false,
        reason: restored.reason,
      }));
    }
  }
  return { facts, isolated };
}

/** Crop, validate, and attach one owner's decoration from the shared isolation frame. */
async function materializeDecorationCrop(
  target: DecorationTarget,
  plan: DecorationClipPlan,
  fact: IsolationFact | undefined,
  isolated: IsolationFrame,
  viewport: NativeControlViewport,
  warnings: CaptureWarning[],
): Promise<void> {
  if (!fact?.connected || !fact.fingerprintMatches) {
    warn(warnings, target, fact?.reason ?? "closed-shadow ownership fingerprint changed");
    return;
  }
  if (isolated == null) {
    warn(warnings, target, "atomic transparent isolation screenshot failed");
    return;
  }
  const pixelCrop = nativeControlPixelCrop(plan.output, viewport, isolated);
  const rgba = pixelCrop == null ? null : cropNativeControlRgba(isolated, pixelCrop);
  if (pixelCrop == null || rgba == null) {
    warn(warnings, target, "decoration crop did not map to isolation pixels");
    return;
  }
  const alpha = nativeControlAlphaStats(rgba);
  if (alpha == null) {
    warn(warnings, target, "isolated decoration had invalid RGBA content");
    return;
  }
  if (alpha.opaque + alpha.translucent === 0) {
    target.raster.empty = true;
    return;
  }
  const clippedLeft = plan.output.x === 0;
  const clippedTop = plan.output.y === 0;
  const clippedRight = plan.output.x + plan.output.width === viewport.width;
  const clippedBottom = plan.output.y + plan.output.height === viewport.height;
  if (
    !target.raster.exactPartBox &&
    nativeDecorationTouchesBoundary(rgba, pixelCrop.width, pixelCrop.height, {
      left: !clippedLeft,
      top: !clippedTop,
      right: !clippedRight,
      bottom: !clippedBottom,
    })
  ) {
    warn(warnings, target, "decoration ink exceeded the validated host overflow guard");
    return;
  }
  const png = await sharp(Buffer.from(rgba), {
    raw: { width: pixelCrop.width, height: pixelCrop.height, channels: 4 },
  })
    .png()
    .toBuffer();
  target.raster.dataUri = `data:image/png;base64,${png.toString("base64")}`;
  target.raster.x = plan.output.x;
  target.raster.y = plan.output.y;
  target.raster.width = plan.output.width;
  target.raster.height = plan.output.height;
}

// ---------------------------------------------------------------------------
// Page-evaluated callbacks. Playwright serializes each function's source and
// runs it in the page, so these must stay self-contained: no imports and no
// references to module scope (type aliases are erased at compile time).
// ---------------------------------------------------------------------------

/**
 * Hide the document, neutralize each host's structural paint, re-show only the
 * retained decoration parts, and verify every owner's identity, geometry, and
 * interaction state still match the CDP pre-pass.
 *
 * Each row takes one of three routes, written as methods on the in-page
 * `helpers` object: the select arrow, the file-selector exact part box, and
 * the generic closed-shadow parts. They share the identity, 0.25px rect and
 * interaction-state checks defined on the same object.
 */
const isolateDecorationsInPage = ({
  sourceNodeKey,
  decorationNodeKey,
  restoreKey,
  rows,
}: IsolationPageArgs): IsolationFact[] => {
  type RestoreEntry =
    | { type: "style"; element: HTMLElement; property: string; value: string; priority: string }
    | { type: "node"; node: Node; parent: Node; nextSibling: Node | null };
  type RetainedPart = { kind?: string; node?: Element };
  type RestoreState = {
    entries: RestoreEntry[];
    activeElement: Element | null;
  };
  type InteractionState = { focus: boolean; hover: boolean; active: boolean };
  const pageGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const sourceNodes = pageGlobal[sourceNodeKey] as Element[] | undefined;
  const restoreState = pageGlobal[restoreKey] as RestoreState;
  const restore = restoreState.entries;
  const initialActiveElement = restoreState.activeElement;
  const interactionStates = rows.map((row): InteractionState | null => {
    const host = row.index == null ? null : (sourceNodes?.[row.index] ?? null);
    return host instanceof HTMLElement
      ? {
          focus: host.matches(":focus"),
          hover: host.matches(":hover"),
          active: host.matches(":active"),
        }
      : null;
  });
  // Object methods survive Playwright's function serialization in both
  // compiled and direct-TSX callers. Locally named functions gain an
  // esbuild `__name(...)` call under TSX, but that helper does not exist in
  // the browser utility world.
  const helpers = {
    set(element: HTMLElement, property: string, value: string): void {
      restore.push({
        type: "style",
        element,
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
      element.style.setProperty(property, value, "important");
    },
    neutralizeHostPaint(host: HTMLElement): void {
      // Keep geometry, writing mode, color, appearance, and interaction
      // state intact. Blink's ThemePainter parts consume several of those
      // values. Only surfaces which the structural renderer owns are made
      // transparent for this one compositor readback.
      this.set(host, "visibility", "visible");
      this.set(host, "opacity", "1");
      this.set(host, "filter", "none");
      this.set(host, "backdrop-filter", "none");
      this.set(host, "mix-blend-mode", "normal");
      this.set(host, "background-color", "transparent");
      this.set(host, "background-image", "none");
      this.set(host, "border-image-source", "none");
      for (const side of ["top", "right", "bottom", "left"]) {
        this.set(host, `border-${side}-color`, "transparent");
      }
      this.set(host, "box-shadow", "none");
      this.set(host, "-webkit-text-fill-color", "transparent");
      this.set(host, "caret-color", "transparent");
      this.set(host, "text-shadow", "none");
      this.set(host, "outline", "none");
    },
    /** Whether no edge or extent of a used rect is more than 0.25px off the pre-pass rect. */
    rectWithin(rect: DOMRect, left: number, top: number, width: number, height: number): boolean {
      // Written as "no edge is off by more than 0.25px" so a NaN coordinate
      // passes here, exactly as the original inline checks let it through.
      return !(
        Math.abs(rect.left - left) > 0.25 ||
        Math.abs(rect.top - top) > 0.25 ||
        Math.abs(rect.width - width) > 0.25 ||
        Math.abs(rect.height - height) > 0.25
      );
    },
    /** The retained part node, if it is still the same connected part inside this host's shadow root. */
    ownedPart(host: HTMLElement, retained: RetainedPart[] | undefined, expected: DecorationPart): HTMLElement | null {
      const entry = retained?.[expected.index];
      const node = entry?.node;
      if (!(node instanceof HTMLElement) || !node.isConnected || entry?.kind !== expected.kind) return null;
      const root = node.getRootNode();
      return root instanceof ShadowRoot && root.host === host ? node : null;
    },
    /** Whether focus, hover, active and the document's active element are what they were before isolation. */
    interactionUnchanged(host: HTMLElement, initial: InteractionState | null): boolean {
      return (
        initial != null &&
        document.activeElement === initialActiveElement &&
        host.matches(":focus") === initial.focus &&
        host.matches(":hover") === initial.hover &&
        host.matches(":active") === initial.active
      );
    },
    mismatch(reason: string): IsolationFact {
      return { connected: true, fingerprintMatches: false, reason };
    },
    isolateSelectArrow(
      host: HTMLElement,
      row: IsolationRow,
      retained: RetainedPart[] | undefined,
      initial: InteractionState | null,
    ): IsolationFact {
      const used = getComputedStyle(host);
      this.set(host, "box-sizing", used.boxSizing);
      this.set(host, "width", used.width);
      this.set(host, "height", used.height);
      // Keep widths/radii/padding and `color`: SetupMenuListArrow consumes
      // those exact values. Only suppress the CSS-owned host surfaces and
      // the selected text. Inline background/border declarations retain
      // the author-origin flags that select kMenulistButton.
      // The selected text lives in a UA-shadow node whose UA !important
      // declarations beat author inline declarations. Detach that exact
      // node for the readback, then restore it at the same sibling slot.
      // Freezing the used host size above keeps SetupMenuListArrow's rect
      // and padding inputs unchanged.
      for (const expected of row.parts ?? []) {
        if (expected.kind !== "select-inner") continue;
        const node = this.ownedPart(host, retained, expected);
        if (node == null || node.parentNode == null) return this.mismatch("select inner owner identity changed");
        if (!this.rectWithin(node.getBoundingClientRect(), expected.x, expected.y, expected.width, expected.height)) {
          return this.mismatch("select inner used rect changed");
        }
        restore.push({ type: "node", node, parent: node.parentNode, nextSibling: node.nextSibling });
        node.remove();
      }
      const { left, top, width, height } = row.hostRect;
      if (!this.rectWithin(host.getBoundingClientRect(), left, top, width, height)) {
        return this.mismatch("select host geometry changed during arrow isolation");
      }
      if (!this.interactionUnchanged(host, initial)) {
        return this.mismatch("select interaction state changed during isolation");
      }
      return { connected: true, fingerprintMatches: true };
    },
    isolateFileSelector(
      host: HTMLElement,
      row: IsolationRow,
      retained: RetainedPart[] | undefined,
      initial: InteractionState | null,
    ): IsolationFact {
      let buttonFound = false;
      let statusFound = false;
      for (const expected of row.parts ?? []) {
        const node = this.ownedPart(host, retained, expected);
        if (node == null) return this.mismatch(`${expected.kind} identity changed`);
        if (!this.rectWithin(node.getBoundingClientRect(), expected.x, expected.y, expected.width, expected.height)) {
          return this.mismatch(`${expected.kind} used rect changed`);
        }
        if (expected.kind === "file-selector-button") {
          buttonFound = true;
          const used = getComputedStyle(node);
          this.set(node, "visibility", "visible");
          // Host text-fill is transparent only to remove the sibling
          // filename. Restore the real child label from its own used
          // color without altering state, font, geometry, or theme paint.
          this.set(node, "-webkit-text-fill-color", used.color);
        } else if (expected.kind === "file-selector-status") {
          statusFound = true;
          this.set(node, "visibility", "hidden");
        }
      }
      if (!buttonFound || !statusFound) return this.mismatch("file-selector button/status topology changed");
      if (!this.interactionUnchanged(host, initial)) {
        return this.mismatch("file input interaction state changed during isolation");
      }
      return { connected: true, fingerprintMatches: true };
    },
    isolateClosedShadowParts(
      host: HTMLElement,
      row: IsolationRow,
      retained: RetainedPart[] | undefined,
      initial: InteractionState | null,
    ): IsolationFact {
      for (const expected of row.parts ?? []) {
        const node = this.ownedPart(host, retained, expected);
        if (node == null) return this.mismatch(`${expected.kind} identity changed`);
        const rect = node.getBoundingClientRect();
        const numbers = [rect.left, rect.top, rect.width, rect.height];
        if (
          !numbers.every(Number.isFinite) ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          !this.rectWithin(rect, expected.x, expected.y, expected.width, expected.height)
        ) {
          return this.mismatch(`${expected.kind} used rect changed`);
        }
        // Other computed part state—opacity, resource, appearance, hover,
        // active, readonly—remains untouched and therefore authoritative.
        this.set(node, "visibility", "visible");
      }
      if (!this.interactionUnchanged(host, initial)) {
        return this.mismatch("control interaction state changed during isolation");
      }
      return { connected: true, fingerprintMatches: true };
    },
  };

  for (const element of Array.from(document.querySelectorAll("*"))) {
    helpers.set(element as HTMLElement, "visibility", "hidden");
  }
  for (const canvas of [document.documentElement, document.body]) {
    if (canvas != null) helpers.set(canvas, "background", "transparent");
  }

  const result = rows.map((row, rowIndex): IsolationFact => {
    const host = row.index == null ? null : (sourceNodes?.[row.index] ?? null);
    if (!(host instanceof HTMLElement) || !host.isConnected) {
      return { connected: false, fingerprintMatches: false, reason: "host detached or lost source correlation" };
    }
    const retained = (host as HTMLElement & Record<string, unknown>)[decorationNodeKey] as RetainedPart[] | undefined;
    helpers.neutralizeHostPaint(host);
    const initial = interactionStates[rowIndex];
    if (row.selectArrow) return helpers.isolateSelectArrow(host, row, retained, initial);
    if (row.exactPartBox) return helpers.isolateFileSelector(host, row, retained, initial);
    return helpers.isolateClosedShadowParts(host, row, retained, initial);
  });
  void document.documentElement.getBoundingClientRect();
  return result;
};

/** Undo every isolation mutation newest-first and verify the page restored exactly. */
const restoreDecorationIsolationInPage = ({
  key,
  sourceNodeKey,
  decorationNodeKey,
  rows,
}: RestorePageArgs): { ok: boolean; reason?: string } => {
  type RestoreEntry =
    | { type: "style"; element: HTMLElement; property: string; value: string; priority: string }
    | { type: "node"; node: Node; parent: Node; nextSibling: Node | null };
  type RetainedPart = { kind?: string; node?: Element };
  type RestoreState = {
    entries: RestoreEntry[];
    activeElement: Element | null;
  };
  const pageGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const state = pageGlobal[key] as RestoreState | undefined;
  const failures: string[] = [];
  // Object methods, not named functions: see the note in isolateDecorationsInPage.
  // These mirror its `rectWithin` / `ownedPart`; the two callbacks run as
  // separate serialized functions and cannot share code.
  const helpers = {
    rectWithin(rect: DOMRect, left: number, top: number, width: number, height: number): boolean {
      // Written as "no edge is off by more than 0.25px" so a NaN coordinate
      // passes here, exactly as the original inline checks let it through.
      return !(
        Math.abs(rect.left - left) > 0.25 ||
        Math.abs(rect.top - top) > 0.25 ||
        Math.abs(rect.width - width) > 0.25 ||
        Math.abs(rect.height - height) > 0.25
      );
    },
    ownedPart(host: HTMLElement, retained: RetainedPart[] | undefined, expected: DecorationPart): HTMLElement | null {
      const entry = retained?.[expected.index];
      const node = entry?.node;
      if (!(node instanceof HTMLElement) || !node.isConnected || entry?.kind !== expected.kind) return null;
      const root = node.getRootNode();
      return root instanceof ShadowRoot && root.host === host ? node : null;
    },
  };
  for (let index = (state?.entries.length ?? 0) - 1; index >= 0; index--) {
    const entry = state!.entries[index];
    if (entry.type === "node") {
      try {
        if (entry.nextSibling != null && entry.nextSibling.parentNode !== entry.parent) {
          throw new Error("saved sibling slot changed");
        }
        entry.parent.insertBefore(entry.node, entry.nextSibling);
        if (entry.node.parentNode !== entry.parent || entry.node.nextSibling !== entry.nextSibling) {
          failures.push("select inner node did not return to its exact sibling slot");
        }
      } catch {
        failures.push("select inner node exact reinsertion failed");
        // Best-effort recovery avoids leaving the live document with a
        // detached UA node, but the crop remains fail-closed below.
        if (entry.parent.isConnected && entry.node.parentNode !== entry.parent) {
          try {
            entry.parent.appendChild(entry.node);
          } catch {
            /* recorded above */
          }
        }
      }
    } else if (entry.value === "") {
      try {
        entry.element.style.removeProperty(entry.property);
      } catch {
        failures.push(`style restore failed: ${entry.property}`);
      }
    } else {
      try {
        entry.element.style.setProperty(entry.property, entry.value, entry.priority);
      } catch {
        failures.push(`style restore failed: ${entry.property}`);
      }
    }
    if (
      entry.type === "style" &&
      (entry.element.style.getPropertyValue(entry.property) !== entry.value ||
        entry.element.style.getPropertyPriority(entry.property) !== entry.priority)
    ) {
      failures.push(`style restore mismatch: ${entry.property}`);
    }
  }
  const sourceNodes = pageGlobal[sourceNodeKey] as Element[] | undefined;
  for (const row of rows) {
    const host = row.index == null ? null : (sourceNodes?.[row.index] ?? null);
    if (!(host instanceof HTMLElement) || !host.isConnected) {
      failures.push("host lost source correlation during restore");
      continue;
    }
    const { left, top, width, height } = row.hostRect;
    if (!helpers.rectWithin(host.getBoundingClientRect(), left, top, width, height)) {
      failures.push("host geometry did not restore exactly");
    }
    const retained = (host as HTMLElement & Record<string, unknown>)[decorationNodeKey] as RetainedPart[] | undefined;
    for (const expected of row.parts ?? []) {
      const node = helpers.ownedPart(host, retained, expected);
      if (node == null) {
        failures.push(`${expected.kind} identity did not restore`);
        continue;
      }
      if (!helpers.rectWithin(node.getBoundingClientRect(), expected.x, expected.y, expected.width, expected.height)) {
        failures.push(`${expected.kind} geometry did not restore exactly`);
      }
    }
  }
  if (state != null && document.activeElement !== state.activeElement) {
    failures.push("document active element changed during isolation");
  }
  return failures.length === 0 ? { ok: true } : { ok: false, reason: failures.join("; ") };
};
