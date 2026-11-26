import type { CDPSession, Page } from "@playwright/test";
import sharp from "sharp";
import { isTransparentBackground } from "../utils/transparent-background.js";
import type { CssQuad, CssRect } from "./replaced-snapshot-geometry.js";

// Keep the native viewport read bounded. Larger or unverified scenes use the
// established geometry clip, including every renderer-owned transform.
const MAX_VIEWPORT_PIXELS = 16_777_216;
const MAX_WITNESS_ELEMENTS = 512;

/** Read only the existing isolation state. Serialized by Playwright. */
function readCanvasViewportWitness({
  rid,
  viewport,
  maxElements,
}: {
  rid: string;
  viewport: CssRect;
  maxElements: number;
}): { fingerprint: string; backgrounds: string[] } | null {
  const { target, saved } =
    (
      globalThis as typeof globalThis & {
        __domotionReplacedSnapshotState?: { target: HTMLElement; saved: unknown[] };
      }
    ).__domotionReplacedSnapshotState ?? {};
  const visual = window.visualViewport;
  const root = document.documentElement;
  if (
    !(target instanceof HTMLCanvasElement) ||
    !target.isConnected ||
    target.getRootNode() !== document ||
    target.getAttribute("data-domotion-rid") !== rid ||
    !target.hasAttribute("data-domotion-snapshot-target") ||
    saved?.length !== 0 ||
    target.hasChildNodes() ||
    target.width === 0 ||
    target.height === 0 ||
    innerWidth !== viewport.width ||
    innerHeight !== viewport.height ||
    devicePixelRatio !== 1 ||
    visual?.scale !== 1 ||
    visual.offsetLeft !== 0 ||
    visual.offsetTop !== 0 ||
    visual.width !== innerWidth ||
    visual.height !== innerHeight ||
    scrollX !== 0 ||
    scrollY !== 0 ||
    root.scrollWidth !== innerWidth ||
    root.scrollHeight !== innerHeight ||
    document.fullscreenElement != null ||
    document.querySelector(":modal, :popover-open, :active-view-transition") != null
  )
    return null;

  const parents = new Set<HTMLElement>();
  const geometry: unknown[] = [];
  const backgrounds: string[] = [];
  let scaleOwner: HTMLElement | undefined;
  for (let element: HTMLElement | null = target; element != null; element = element.parentElement) {
    if (element !== target && element !== root && element !== document.body && !(element instanceof HTMLDivElement))
      return null;
    parents.add(element);
    const style = getComputedStyle(element);
    if (
      style.display !== "block" ||
      style.visibility !== (element === target ? "visible" : "hidden") ||
      style.opacity !== "1" ||
      style.overflowX !== "visible" ||
      style.overflowY !== "visible" ||
      style.clip !== "auto" ||
      style.clipPath !== "none" ||
      style.maskImage !== "none" ||
      style.mixBlendMode !== "normal" ||
      style.filter !== "none" ||
      style.backdropFilter !== "none" ||
      style.contain !== "none" ||
      style.containerType !== "normal" ||
      style.contentVisibility !== "visible" ||
      style.zoom !== "1" ||
      style.rotate !== "none" ||
      style.translate !== "none" ||
      style.scale !== "none" ||
      style.perspective !== "none" ||
      style.transformStyle !== "flat" ||
      style.offsetPath !== "none" ||
      style.columnCount !== "auto" ||
      style.columnWidth !== "auto" ||
      style.getPropertyValue("scroll-marker-group") !== "none" ||
      style.getPropertyValue("-webkit-box-reflect") !== "none" ||
      style.content !== "normal"
    )
      return null;
    if (
      element === target &&
      (style.padding !== "0px" ||
        style.borderWidth !== "0px" ||
        style.borderRadius !== "0px" ||
        style.outlineStyle !== "none" ||
        style.boxShadow !== "none" ||
        style.objectFit !== "fill")
    )
      return null;
    if (element === target || element === root || element === document.body) {
      if (style.backgroundImage !== "none") return null;
      backgrounds.push(style.backgroundColor);
    }
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(element, pseudo).content;
      if (content !== "none" && content !== "normal") return null;
    }
    if (style.transform !== "none") {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (
        scaleOwner != null ||
        !matrix.is2D ||
        matrix.b !== 0 ||
        matrix.c !== 0 ||
        matrix.a <= 0 ||
        matrix.d <= 0 ||
        (matrix.a === 1 && matrix.d === 1)
      )
        return null;
      scaleOwner = element;
    }
    const { x, y, width, height } = element.getBoundingClientRect();
    geometry.push([x, y, width, height, style.transform, style.transformOrigin]);
  }
  // The existing stylesheet's visibility override can lose to author paint.
  // A full viewport sample requires an actual non-rendering remainder.
  const elements = document.getElementsByTagName("*");
  if (elements.length > maxElements) return null;
  for (const element of Array.from(elements)) {
    if (element !== target && element.hasAttribute("data-domotion-snapshot-target")) return null;
    if (!parents.has(element as HTMLElement) && getComputedStyle(element).display !== "none") return null;
  }
  const [animation, ...otherAnimations] = document.getAnimations();
  if (
    scaleOwner == null ||
    animation == null ||
    otherAnimations.length !== 0 ||
    animation.pending ||
    animation.playState !== "paused" ||
    typeof animation.currentTime !== "number" ||
    !(animation.effect instanceof KeyframeEffect) ||
    animation.effect.target !== scaleOwner
  )
    return null;
  return {
    fingerprint: JSON.stringify([
      geometry,
      backgrounds,
      target.width,
      target.height,
      animation.currentTime,
      animation.playbackRate,
    ]),
    backgrounds,
  };
}

/** Tie the stock marked target to the actual Blink node, through a pierced
 * document read that refuses closed/UA roots and embedded documents. */
async function readCanvasDocumentWitness(cdp: CDPSession, rid: string, quad: CssQuad) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const ids: number[] = [];
  const pending = [root];
  let canvas: number | undefined;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.shadowRoots?.length || node.contentDocument != null) return null;
    ids.push(node.backendNodeId);
    if (node.nodeName === "CANVAS") {
      const attrs = node.attributes ?? [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] !== "data-domotion-rid" || attrs[i + 1] !== rid) continue;
        if (canvas != null) return null;
        canvas = node.backendNodeId;
      }
    }
    pending.push(...(node.children ?? []));
  }
  if (canvas == null) return null;
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: canvas });
  if (model.content.length !== quad.length || model.content.some((coordinate, i) => coordinate !== quad[i]))
    return null;
  return { ids, canvas };
}

function alphaBounds(data: Buffer, width: number, height: number): CssRect | null {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** The CSS content quad does not include paint snapping before a held scale.
 * Only a fully witnessed native viewport can recover the ink outside it. */
export async function captureIsolatedCanvasInk(
  page: Page,
  cdp: CDPSession,
  rid: string,
  viewport: CssRect,
  quad: CssQuad,
  clip: CssRect,
): Promise<{ png: Buffer; rect: CssRect } | null> {
  if (viewport.x !== 0 || viewport.y !== 0 || viewport.width * viewport.height > MAX_VIEWPORT_PIXELS) return null;
  const args = { rid, viewport, maxElements: MAX_WITNESS_ELEMENTS };
  const readViewportWitness = async () => {
    const witness = await page.evaluate(readCanvasViewportWitness, args);
    return witness?.backgrounds.every(isTransparentBackground) ? witness.fingerprint : null;
  };
  const before = await readViewportWitness().catch(() => null);
  if (before == null) return null;
  if (
    !(await cdp.send("CSS.enable").then(
      () => true,
      () => false,
    ))
  )
    return null;
  const invalidators = [
    "DOM.documentUpdated",
    "DOM.attributeModified",
    "DOM.attributeRemoved",
    "DOM.characterDataModified",
    "DOM.childNodeInserted",
    "DOM.childNodeRemoved",
    "DOM.childNodeCountUpdated",
    "DOM.shadowRootPushed",
    "DOM.shadowRootPopped",
    "CSS.styleSheetAdded",
    "CSS.styleSheetRemoved",
    "CSS.styleSheetChanged",
  ] as const;
  let changed = false;
  const invalidate = () => {
    changed = true;
  };
  for (const event of invalidators) cdp.on(event, invalidate);
  let png: Buffer;
  try {
    const document = await readCanvasDocumentWitness(cdp, rid, quad).catch(() => null);
    if (document == null || changed) return null;
    png = await page.screenshot({
      omitBackground: true,
      type: "png",
      scale: "device",
      caret: "initial",
      timeout: 5000,
    });
    const after = await readViewportWitness();
    const currentDocument = await readCanvasDocumentWitness(cdp, rid, quad);
    if (changed || before !== after || JSON.stringify(document) !== JSON.stringify(currentDocument)) {
      throw new Error("isolated canvas or viewport changed during paint sampling");
    }
  } finally {
    for (const event of invalidators) cdp.off(event, invalidate);
    await cdp.send("CSS.disable").catch(() => undefined);
  }
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== viewport.width || info.height !== viewport.height || info.channels !== 4) {
    throw new Error("isolated canvas screenshot does not match the witnessed viewport pixels");
  }
  const ink = alphaBounds(data, info.width, info.height);
  // Keep the ordinary crop when it already contains every painted pixel.
  const rect =
    ink == null ||
    (ink.x >= clip.x &&
      ink.y >= clip.y &&
      ink.x + ink.width <= clip.x + clip.width &&
      ink.y + ink.height <= clip.y + clip.height)
      ? clip
      : ink;
  const cropped = await sharp(png)
    .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
    .png()
    .toBuffer();
  return { png: cropped, rect };
}
