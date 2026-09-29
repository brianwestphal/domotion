/**
 * Region overlay for the demos:review tool. See `docs/31-region-feedback.md`
 * (DM-570) for the contract.
 *
 * Wires up an SVG overlay over each of the three triplet figures inside a
 * review card so the user can:
 *   - mousedown-drag in empty space → draw a new rectangle
 *   - mousedown-drag on an edge or corner handle of an existing rectangle → resize
 *   - mousedown on the interior of an existing rectangle → delete it
 *   - mousedown-up in empty space without crossing the drag threshold → click
 *     falls through to the figure, popping the lightbox (DM-585).
 *
 * Rectangle state is shared across the three figures (the triplet is always
 * the same source-PNG dimensions in the real-world suite). Coordinates are
 * normalized to the source PNG's natural pixel space so the same rect renders
 * at the same place regardless of how the image is scaled in CSS.
 *
 * Designed to live inside a `data-morph-skip` card subtree so kerfjs's
 * morphdom doesn't disturb the overlays on filter/sort re-renders.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const EDGE_HIT = 6; // px hit-region around an edge / corner before promoted to resize handle
const MIN_SIZE = 4; // px in source-PNG space — smaller rectangles snap-collapse and are dropped
const DRAG_THRESHOLD = 4; // px in source-PNG space — below this on pointerup, treat as click, not draw

export interface Rect {
  /** 1-based label, unique within a card; renumbered densely after a delete. */
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  image?: string;
  caption?: string;
}

export interface OverlayHandle {
  /** Snapshot the current rectangles, sorted by (1-based) index. */
  getRegions(): Rect[];
  /** DM-952: write a caption onto the rect at the given index. The
   *  caption persists across reindex-after-delete operations because
   *  it's stored on the internal Rect, not in caller state keyed by a
   *  mutable index. Caller-side state keyed by the overlay's `index`
   *  field would drift after delete (rects 3→2→1 inherit captions from
   *  the wrong source). No-op when no rect at that index. */
  setCaption(index: number, caption: string): void;
  /** Add a rectangle supplied through a non-pointer UI. */
  addRegion(rect: Omit<Rect, "index">): void;
  /** Drop every in-progress rectangle and repaint. */
  clear(): void;
  /** Attach a secondary viewing + editing surface that shares the same
   *  rects array as the in-grid triplet. Used by the fullscreen lightbox so
   *  drag-add-resize-delete on the maximized image edits the same rectangles
   *  that appear on the card's three thumbnails. The caller supplies an
   *  `<img>` and an `<svg>` already positioned over it; this wires pointer
   *  handlers and repaint into the shared pool. `onClickThrough` is invoked
   *  when the user clicks on the overlay without crossing the drag
   *  threshold (the lightbox uses this to close the maximized view).
   *  Returns a `detach()` callback that removes pointer handlers and stops
   *  re-rendering this view (the SVG element itself stays — the caller
   *  owns it). */
  addView(img: HTMLImageElement, svg: SVGSVGElement, onClickThrough?: () => void): () => void;
}

type DragMode =
  | { kind: "pending-draw"; originX: number; originY: number }
  | { kind: "draw"; originX: number; originY: number }
  | { kind: "resize"; rect: Rect; handles: ResizeHandles }
  | null;

interface ResizeHandles {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

interface FigureContext {
  figure: HTMLElement;
  img: HTMLImageElement;
  svg: SVGSVGElement;
}

/** Longest caption shown on the image before it is cut with an ellipsis (source-pixel budget, not a limit on the caption). */
export const CAPTION_PREVIEW_MAX_CHARS = 44;
/** Approximate advance of the 14 px monospace label font in source pixels, and the label's padding and height. */
const CAPTION_CHAR_W = 8.4;
const CAPTION_PAD = 6;
const CAPTION_H = 22;
/** Fewest characters worth drawing beside the badge; below this the label drops to the line under it. */
const CAPTION_MIN_INLINE_CHARS = 12;

/** The single-line, length-bounded text drawn on the image for a caption: whitespace collapsed, ellipsis when cut. */
export function captionPreviewText(caption: string | undefined, maxChars: number = CAPTION_PREVIEW_MAX_CHARS): string {
  const flat = (caption ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return maxChars < 2 ? "" : `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Resolve client-X/Y to source-PNG pixel coords for a given image. */
function clientToSource(img: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | null {
  if (img.naturalWidth === 0 || img.naturalHeight === 0) return null;
  const rect = img.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const sx = (clientX - rect.left) * (img.naturalWidth / rect.width);
  const sy = (clientY - rect.top) * (img.naturalHeight / rect.height);
  return {
    x: Math.max(0, Math.min(img.naturalWidth, Math.round(sx))),
    y: Math.max(0, Math.min(img.naturalHeight, Math.round(sy))),
  };
}

function hitTestResize(rect: Rect, x: number, y: number, edgePx: number): ResizeHandles | null {
  const insideX = x >= rect.x - edgePx && x <= rect.x + rect.w + edgePx;
  const insideY = y >= rect.y - edgePx && y <= rect.y + rect.h + edgePx;
  if (!insideX || !insideY) return null;
  const left = Math.abs(x - rect.x) <= edgePx;
  const right = Math.abs(x - (rect.x + rect.w)) <= edgePx;
  const top = Math.abs(y - rect.y) <= edgePx;
  const bottom = Math.abs(y - (rect.y + rect.h)) <= edgePx;
  if (!left && !right && !top && !bottom) return null;
  return { left, right, top, bottom };
}

function hitTestInterior(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function resizeCursor(h: ResizeHandles): string {
  if ((h.left && h.top) || (h.right && h.bottom)) return "nwse-resize";
  if ((h.right && h.top) || (h.left && h.bottom)) return "nesw-resize";
  if (h.left || h.right) return "ew-resize";
  if (h.top || h.bottom) return "ns-resize";
  return "default";
}

// One overlay per card: a second `enableRegionOverlays(card)` would wrap the figures in a second
// `.region-stage` and stack a second set of listeners over the first, so it returns the existing handle.
const handleByCard = new WeakMap<HTMLElement, OverlayHandle>();

export function enableRegionOverlays(card: HTMLElement): OverlayHandle {
  const existing = handleByCard.get(card);
  if (existing != null) return existing;
  const handle = createRegionOverlays(card);
  if (card.querySelector(".region-overlay") != null) handleByCard.set(card, handle);
  return handle;
}

function createRegionOverlays(card: HTMLElement): OverlayHandle {
  const figureEls = Array.from(card.querySelectorAll<HTMLElement>(".imgs figure[data-src]"));
  if (figureEls.length === 0) {
    return {
      getRegions: () => [],
      setCaption: () => {},
      addRegion: () => {},
      clear: () => {},
      addView: () => () => {},
    };
  }

  const rects: Rect[] = [];
  const figures: FigureContext[] = [];

  // Compute the source dimensions for hit-testing. Set once the first img loads.
  let sourceW = 0;
  let sourceH = 0;

  const updateSourceFromImg = (img: HTMLImageElement, svg: SVGSVGElement): void => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      svg.setAttribute("viewBox", `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
      if (sourceW === 0) {
        sourceW = img.naturalWidth;
        sourceH = img.naturalHeight;
      }
    }
  };

  for (const figure of figureEls) {
    const img = figure.querySelector<HTMLImageElement>("img");
    if (img == null) continue;

    // Wrap the existing image in a stage so the SVG overlay can absolutely
    // position to the same rectangle as the image. The stage carries the
    // same display rect as the image; the SVG is sized to fill it.
    const stage = document.createElement("div");
    stage.className = "region-stage";
    img.parentNode?.insertBefore(stage, img);
    stage.appendChild(img);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("region-overlay");
    svg.setAttribute("preserveAspectRatio", "none");
    stage.appendChild(svg);

    if (img.complete) updateSourceFromImg(img, svg);
    else img.addEventListener("load", () => updateSourceFromImg(img, svg));

    figures.push({ figure, img, svg });
  }

  // ── Rendering ──

  function repaintAll(): void {
    for (const ctx of figures) repaint(ctx);
  }

  function repaint(ctx: FigureContext): void {
    while (ctx.svg.firstChild) ctx.svg.removeChild(ctx.svg.firstChild);
    for (const r of rects) {
      const g = document.createElementNS(SVG_NS, "g");
      g.dataset["rectIndex"] = String(r.index);

      const box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", String(r.x));
      box.setAttribute("y", String(r.y));
      box.setAttribute("width", String(r.w));
      box.setAttribute("height", String(r.h));
      box.setAttribute("class", "region-rect");
      g.appendChild(box);

      const labelBg = document.createElementNS(SVG_NS, "rect");
      const labelText = `[${r.index}]`;
      // Sized to the label text: `[N]` in the 14 px monospace label font (about 8.4 px per character)
      // plus the 4 px text inset and a matching right pad. The old fixed width was one character short, so
      // the closing bracket spilled off the badge onto the image.
      const labelW = Math.round(labelText.length * CAPTION_CHAR_W) + 8;
      const labelH = 22;
      labelBg.setAttribute("x", String(r.x));
      labelBg.setAttribute("y", String(r.y));
      labelBg.setAttribute("width", String(labelW));
      labelBg.setAttribute("height", String(labelH));
      labelBg.setAttribute("class", "region-label-bg");
      g.appendChild(labelBg);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(r.x + 4));
      label.setAttribute("y", String(r.y + 17));
      label.setAttribute("class", "region-label-text");
      label.textContent = labelText;
      g.appendChild(label);

      appendCaptionPreview(g, r, labelW);

      ctx.svg.appendChild(g);
    }
  }

  /**
   * Show the region's caption next to its badge while the reviewer types it, so the annotation reads on the
   * image itself, not only in the list below. The preview is a plain label: it takes no pointer events and
   * is never consulted by the hit tests (those run on the rect geometry), so drag, resize and delete behave
   * exactly as before. Long captions are truncated with an ellipsis; the full text stays in the region list
   * and in the serialized REGIONS block.
   *
   * Placement never covers the badge: the label sits to its right, truncated to the room left in the image;
   * when a region hugs the right edge and less than `CAPTION_MIN_INLINE_CHARS` would fit there, the label
   * drops to a second line under the badge instead, where it may use the image's full width.
   */
  function appendCaptionPreview(g: SVGGElement, r: Rect, badgeW: number): void {
    const known = sourceW > 0;
    const rightRoom = known ? sourceW - (r.x + badgeW) : Infinity;
    const charsFor = (room: number): number => Math.floor((room - CAPTION_PAD * 2) / CAPTION_CHAR_W);
    let x = r.x + badgeW;
    let y = r.y;
    let chars = Math.min(CAPTION_PREVIEW_MAX_CHARS, charsFor(rightRoom));
    if (known && chars < CAPTION_MIN_INLINE_CHARS) {
      // Not enough room beside the badge: use the line below it, starting at the region's left edge.
      chars = Math.min(CAPTION_PREVIEW_MAX_CHARS, charsFor(sourceW));
      y = r.y + CAPTION_H;
      const width =
        Math.round(Math.min(chars, captionPreviewText(r.caption, chars).length) * CAPTION_CHAR_W) + CAPTION_PAD * 2;
      x = Math.max(0, Math.min(r.x, sourceW - width));
    }
    const text = captionPreviewText(r.caption, chars);
    if (text === "") return;
    const width = Math.round(text.length * CAPTION_CHAR_W) + CAPTION_PAD * 2;
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", String(x));
    bg.setAttribute("y", String(y));
    bg.setAttribute("width", String(width));
    bg.setAttribute("height", String(CAPTION_H));
    bg.setAttribute("class", "region-caption-bg");
    bg.setAttribute("pointer-events", "none");
    g.appendChild(bg);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(x + CAPTION_PAD));
    label.setAttribute("y", String(y + 17));
    label.setAttribute("class", "region-caption-text");
    label.setAttribute("pointer-events", "none");
    label.textContent = text;
    g.appendChild(label);
  }

  // ── Numbering ──

  function nextIndex(): number {
    let n = 1;
    while (rects.some((r) => r.index === n)) n++;
    return n;
  }

  function reindex(): void {
    rects.sort((a, b) => a.index - b.index);
    rects.forEach((r, i) => {
      r.index = i + 1;
    });
  }

  // ── Drag handling ──

  // Wire pointer handlers on a single figure's SVG overlay. Returns a
  // teardown callback that removes the listeners (used by addView() so the
  // lightbox can detach its overlay cleanly on close). The card's three
  // built-in figures don't need teardown (their lifecycle is the card's)
  // but we route through the same helper so the behavior matches across
  // surfaces.
  function wireFigure(ctx: FigureContext, onClickThroughOverride?: () => void): () => void {
    let drag: DragMode = null;

    const onHoverMove = (ev: PointerEvent): void => {
      // Only update hover-cursor when not in a drag.
      if (drag != null) return;
      const p = clientToSource(ctx.img, ev.clientX, ev.clientY);
      if (p == null) return;
      let cursor = "crosshair";
      for (const r of rects) {
        const h = hitTestResize(r, p.x, p.y, EDGE_HIT);
        if (h != null && (h.left || h.right || h.top || h.bottom)) {
          cursor = resizeCursor(h);
          break;
        } else if (hitTestInterior(r, p.x, p.y)) {
          cursor = "not-allowed";
          break;
        }
      }
      ctx.svg.style.cursor = cursor;
    };

    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;
      const p = clientToSource(ctx.img, ev.clientX, ev.clientY);
      if (p == null) return;

      // Resize takes precedence over interior-click.
      for (const r of rects) {
        const h = hitTestResize(r, p.x, p.y, EDGE_HIT);
        if (h != null && (h.left || h.right || h.top || h.bottom)) {
          drag = { kind: "resize", rect: r, handles: h };
          ev.preventDefault();
          ev.stopPropagation();
          ctx.svg.setPointerCapture(ev.pointerId);
          return;
        }
      }
      // Interior click → delete.
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]!;
        if (hitTestInterior(r, p.x, p.y)) {
          rects.splice(i, 1);
          reindex();
          repaintAll();
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
      }
      // Empty area → tentatively start drawing. We defer pushing a rect until
      // pointermove crosses DRAG_THRESHOLD; a pointerup before then is a plain
      // click and falls through to the lightbox (DM-585).
      ev.preventDefault();
      ev.stopPropagation();
      ctx.svg.setPointerCapture(ev.pointerId);
      drag = { kind: "pending-draw", originX: p.x, originY: p.y };
    };

    const onDragMove = (ev: PointerEvent): void => {
      if (drag == null) return;
      const p = clientToSource(ctx.img, ev.clientX, ev.clientY);
      if (p == null) return;
      if (drag.kind === "pending-draw") {
        const dx = Math.abs(p.x - drag.originX);
        const dy = Math.abs(p.y - drag.originY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        // Promote the gesture: now we're actually drawing.
        const newRect: Rect = { index: nextIndex(), x: drag.originX, y: drag.originY, w: 0, h: 0 };
        rects.push(newRect);
        drag = { kind: "draw", originX: drag.originX, originY: drag.originY };
      }
      if (drag.kind === "draw") {
        const r = rects[rects.length - 1]!;
        r.x = Math.min(drag.originX, p.x);
        r.y = Math.min(drag.originY, p.y);
        r.w = Math.abs(p.x - drag.originX);
        r.h = Math.abs(p.y - drag.originY);
      } else {
        const r = drag.rect;
        if (drag.handles.left) {
          const right = r.x + r.w;
          r.x = Math.min(p.x, right - MIN_SIZE);
          r.w = right - r.x;
        }
        if (drag.handles.right) {
          r.w = Math.max(MIN_SIZE, p.x - r.x);
        }
        if (drag.handles.top) {
          const bottom = r.y + r.h;
          r.y = Math.min(p.y, bottom - MIN_SIZE);
          r.h = bottom - r.y;
        }
        if (drag.handles.bottom) {
          r.h = Math.max(MIN_SIZE, p.y - r.y);
        }
      }
      // Clamp to source bounds.
      if (sourceW > 0 && sourceH > 0) {
        const r = drag.kind === "draw" ? rects[rects.length - 1]! : drag.rect;
        r.x = Math.max(0, Math.min(r.x, sourceW - MIN_SIZE));
        r.y = Math.max(0, Math.min(r.y, sourceH - MIN_SIZE));
        r.w = Math.min(r.w, sourceW - r.x);
        r.h = Math.min(r.h, sourceH - r.y);
      }
      repaintAll();
    };

    const onClickThrough = (): void => {
      if (onClickThroughOverride != null) {
        onClickThroughOverride();
        return;
      }
      // No drag happened — surface the click on the figure so the existing
      // delegated handler in review-client.tsx pops the lightbox. The synthetic
      // event's target is the figure itself, so the overlay-origin guard there
      // doesn't see it as coming from .region-overlay.
      ctx.figure.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };

    const endDrag = (ev: PointerEvent): void => {
      if (drag == null) return;
      if (ctx.svg.hasPointerCapture(ev.pointerId)) ctx.svg.releasePointerCapture(ev.pointerId);
      const wasPending = drag.kind === "pending-draw";
      if (drag.kind === "draw") {
        const r = rects[rects.length - 1]!;
        if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
          rects.pop();
          repaintAll();
        }
      }
      drag = null;
      if (wasPending) onClickThrough();
    };

    // A cancelled gesture (the browser took the pointer for a scroll, the pointer left the window, ...)
    // is not a click: it must not fall through to the lightbox, and a rectangle that was still being
    // drawn is abandoned rather than left half-drawn. A cancelled resize keeps its last geometry.
    const cancelDrag = (ev: PointerEvent): void => {
      if (drag == null) return;
      if (ctx.svg.hasPointerCapture(ev.pointerId)) ctx.svg.releasePointerCapture(ev.pointerId);
      if (drag.kind === "draw") {
        rects.pop();
        repaintAll();
      }
      drag = null;
    };

    ctx.svg.addEventListener("pointermove", onHoverMove);
    ctx.svg.addEventListener("pointerdown", onPointerDown);
    ctx.svg.addEventListener("pointermove", onDragMove);
    ctx.svg.addEventListener("pointerup", endDrag);
    ctx.svg.addEventListener("pointercancel", cancelDrag);

    return () => {
      ctx.svg.removeEventListener("pointermove", onHoverMove);
      ctx.svg.removeEventListener("pointerdown", onPointerDown);
      ctx.svg.removeEventListener("pointermove", onDragMove);
      ctx.svg.removeEventListener("pointerup", endDrag);
      ctx.svg.removeEventListener("pointercancel", cancelDrag);
    };
  }

  for (const ctx of figures) wireFigure(ctx);

  return {
    getRegions: () => rects.map((r) => ({ ...r })).sort((a, b) => a.index - b.index),
    setCaption: (index: number, caption: string) => {
      const target = rects.find((r) => r.index === index);
      if (target == null) return;
      target.caption = caption;
      repaintAll();
    },
    addRegion: (rect) => {
      rects.push({ ...rect, index: nextIndex() });
      repaintAll();
    },
    clear: () => {
      rects.length = 0;
      repaintAll();
    },
    addView: (img, svg, onClickThrough) => {
      svg.setAttribute("preserveAspectRatio", "none");
      const onLoad = (): void => updateSourceFromImg(img, svg);
      if (img.complete) updateSourceFromImg(img, svg);
      else img.addEventListener("load", onLoad);
      // A synthetic figure host for the click-through path's
      // legacy-fallback (the caller normally supplies an explicit override
      // for the lightbox — close the maximised view on click — so the
      // synthetic-click dispatch never fires for this surface).
      const noopFigure = document.createElement("div");
      const ctx: FigureContext = { figure: noopFigure, img, svg };
      figures.push(ctx);
      const teardown = wireFigure(ctx, onClickThrough);
      repaint(ctx);
      return () => {
        teardown();
        img.removeEventListener("load", onLoad);
        const idx = figures.indexOf(ctx);
        if (idx >= 0) figures.splice(idx, 1);
        // The caller owns the <svg> element but not the rectangles this view painted into it.
        while (svg.firstChild) svg.removeChild(svg.firstChild);
      };
    },
  };
}

/** Serialize a list of rectangles into the canonical `REGIONS:` block. */
export function serializeRegions(rects: Rect[]): string {
  if (rects.length === 0) return "";
  const lines = ["REGIONS:"];
  for (const r of rects) {
    const pin = r.image != null ? `image=${r.image} ` : "";
    const coords = `(x=${r.x} y=${r.y} w=${r.w} h=${r.h})`;
    const caption = r.caption != null && r.caption.trim() !== "" ? ` — ${r.caption.trim()}` : "";
    lines.push(`- [${r.index}] ${pin}${coords}${caption}`);
  }
  return lines.join("\n");
}
