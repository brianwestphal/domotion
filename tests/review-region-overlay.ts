/**
 * Region overlay for the demos:review tool. See `docs/31-region-feedback.md`
 * (DM-570) for the contract.
 *
 * Wires up an SVG overlay over each of the three triplet figures inside a
 * review card so the user can:
 *   - mousedown-drag in empty space → draw a new rectangle
 *   - mousedown-drag on an edge or corner handle of an existing rectangle → resize
 *   - mousedown on the interior of an existing rectangle → delete it
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

export interface Rect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  image?: string;
  caption?: string;
}

export interface OverlayHandle {
  /** Snapshot the current rectangles, sorted by index. */
  getRegions(): Rect[];
  /** Drop every in-progress rectangle and repaint. */
  clear(): void;
}

type DragMode =
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

export function enableRegionOverlays(card: HTMLElement): OverlayHandle {
  const figureEls = Array.from(card.querySelectorAll<HTMLElement>(".imgs figure[data-src]"));
  if (figureEls.length === 0) {
    return { getRegions: () => [], clear: () => {} };
  }

  const rects: Rect[] = [];
  const figures: FigureContext[] = [];

  // Compute the source dimensions for hit-testing. Set once the first img loads.
  let sourceW = 0;
  let sourceH = 0;

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

    const updateViewBox = (): void => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        svg.setAttribute("viewBox", `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
        if (sourceW === 0) {
          sourceW = img.naturalWidth;
          sourceH = img.naturalHeight;
        }
      }
    };
    if (img.complete) updateViewBox();
    else img.addEventListener("load", updateViewBox);

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
      // Sized roughly to the label text. The numeric width is intentionally
      // generous so the SVG-coord-space label remains readable when the
      // image is scaled down in CSS.
      const labelW = 22 + (labelText.length - 3) * 12;
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

      ctx.svg.appendChild(g);
    }
  }

  // ── Numbering ──

  function nextIndex(): number {
    let n = 1;
    while (rects.some((r) => r.index === n)) n++;
    return n;
  }

  function reindex(): void {
    rects.sort((a, b) => a.index - b.index);
    rects.forEach((r, i) => { r.index = i + 1; });
  }

  // ── Drag handling ──

  for (const ctx of figures) {
    let drag: DragMode = null;

    ctx.svg.addEventListener("pointermove", (ev) => {
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
    });

    ctx.svg.addEventListener("pointerdown", (ev) => {
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
      // Empty area → start drawing a new rect.
      ev.preventDefault();
      ev.stopPropagation();
      ctx.svg.setPointerCapture(ev.pointerId);
      const newRect: Rect = { index: nextIndex(), x: p.x, y: p.y, w: 0, h: 0 };
      rects.push(newRect);
      drag = { kind: "draw", originX: p.x, originY: p.y };
      repaintAll();
    });

    ctx.svg.addEventListener("pointermove", (ev) => {
      if (drag == null) return;
      const p = clientToSource(ctx.img, ev.clientX, ev.clientY);
      if (p == null) return;
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
    });

    const endDrag = (ev: PointerEvent): void => {
      if (drag == null) return;
      if (ctx.svg.hasPointerCapture(ev.pointerId)) ctx.svg.releasePointerCapture(ev.pointerId);
      if (drag.kind === "draw") {
        const r = rects[rects.length - 1]!;
        if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
          rects.pop();
          repaintAll();
        }
      }
      drag = null;
    };
    ctx.svg.addEventListener("pointerup", endDrag);
    ctx.svg.addEventListener("pointercancel", endDrag);
  }

  return {
    getRegions: () => rects.map((r) => ({ ...r })),
    clear: () => {
      rects.length = 0;
      repaintAll();
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

