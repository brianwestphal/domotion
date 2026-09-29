// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import {
  CAPTION_PREVIEW_MAX_CHARS,
  captionPreviewText,
  enableRegionOverlays,
  serializeRegions,
} from "./region-overlay.js";

function buildCard({
  naturalW = 100,
  naturalH = 100,
  displayW = 100,
  displayH = 100,
}: { naturalW?: number; naturalH?: number; displayW?: number; displayH?: number } = {}): {
  card: HTMLElement;
  figures: HTMLElement[];
} {
  document.body.innerHTML = `
    <div class="card">
      <div class="imgs">
        <figure data-src="/expected.png"><figcaption>expected</figcaption><img alt="" /></figure>
        <figure data-src="/actual.png"><figcaption>actual</figcaption><img alt="" /></figure>
        <figure data-src="/diff.png"><figcaption>diff</figcaption><img alt="" /></figure>
      </div>
    </div>
  `;
  const card = document.body.querySelector(".card") as HTMLElement;
  const figures = Array.from(card.querySelectorAll<HTMLElement>("figure[data-src]"));
  for (const fig of figures) {
    const img = fig.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: naturalW, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: naturalH, configurable: true });
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    img.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: displayW,
      bottom: displayH,
      width: displayW,
      height: displayH,
      x: 0,
      y: 0,
      toJSON: () => "",
    });
  }
  return { card, figures };
}

function pointer(target: Element, type: string, clientX: number, clientY: number): void {
  const ev = new PointerEvent(type, {
    clientX,
    clientY,
    button: 0,
    bubbles: true,
    cancelable: true,
    pointerId: 1,
  });
  target.dispatchEvent(ev);
}

function overlaySvg(figure: HTMLElement): SVGSVGElement {
  const svg = figure.querySelector(".region-overlay");
  if (svg == null) throw new Error("overlay svg missing");
  return svg as SVGSVGElement;
}

describe("region overlay — click vs drag (DM-585)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("dispatches a click on the figure when pointerdown/up has no movement", () => {
    const { card, figures } = buildCard();
    enableRegionOverlays(card);
    const figure = figures[0]!;
    let clickCount = 0;
    figure.addEventListener("click", () => {
      clickCount++;
    });
    const svg = overlaySvg(figure);
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointerup", 10, 10);
    expect(clickCount).toBe(1);
  });

  it("does not push a rect on a click with no movement", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const svg = overlaySvg(figures[0]!);
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointerup", 10, 10);
    expect(handle.getRegions()).toEqual([]);
  });

  it("adds and paints a region supplied by a keyboard-capable control (DM-2598)", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    handle.addRegion({ x: 25, y: 25, w: 50, h: 50 });
    expect(handle.getRegions()).toEqual([{ index: 1, x: 25, y: 25, w: 50, h: 50 }]);
    expect(overlaySvg(figures[0]!).querySelectorAll("rect.region-rect")).toHaveLength(1);
  });

  it("still falls through to a click when the pointer moves below the drag threshold", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const figure = figures[0]!;
    let clickCount = 0;
    figure.addEventListener("click", () => {
      clickCount++;
    });
    const svg = overlaySvg(figure);
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointermove", 12, 11); // 2px x, 1px y — below threshold
    pointer(svg, "pointerup", 12, 11);
    expect(handle.getRegions()).toEqual([]);
    expect(clickCount).toBe(1);
  });

  it("draws a rect when pointermove crosses the drag threshold", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const figure = figures[0]!;
    let clickCount = 0;
    figure.addEventListener("click", () => {
      clickCount++;
    });
    const svg = overlaySvg(figure);
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointermove", 50, 50);
    pointer(svg, "pointerup", 50, 50);
    const regions = handle.getRegions();
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ x: 10, y: 10, w: 40, h: 40 });
    // A real drag must not also fire the lightbox click.
    expect(clickCount).toBe(0);
  });

  it("addView lets a fullscreen surface edit the same rects as the card triplet (DM-736)", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    // Build a separate fullscreen-style img + svg over the same source PNG.
    const lbStage = document.createElement("div");
    document.body.appendChild(lbStage);
    const lbImg = document.createElement("img");
    Object.defineProperty(lbImg, "naturalWidth", { value: 100, configurable: true });
    Object.defineProperty(lbImg, "naturalHeight", { value: 100, configurable: true });
    Object.defineProperty(lbImg, "complete", { value: true, configurable: true });
    lbImg.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => "",
    });
    lbStage.appendChild(lbImg);
    const lbSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    lbStage.appendChild(lbSvg);
    let clickThroughCount = 0;
    const detach = handle.addView(lbImg, lbSvg, () => {
      clickThroughCount++;
    });

    // Draw a rect on the fullscreen surface (note clientX=20 → source x=10 because of 2× scale).
    pointer(lbSvg, "pointerdown", 20, 20);
    pointer(lbSvg, "pointermove", 100, 100);
    pointer(lbSvg, "pointerup", 100, 100);
    expect(handle.getRegions()).toHaveLength(1);
    expect(handle.getRegions()[0]).toMatchObject({ x: 10, y: 10, w: 40, h: 40 });
    // The card triplet's SVGs should have rendered the same rect.
    expect(overlaySvg(figures[0]!).querySelectorAll("rect.region-rect")).toHaveLength(1);

    // A click with no drag fires the onClickThrough callback, NOT the
    // figure-dispatched click that the card overlay uses.
    pointer(lbSvg, "pointerdown", 5, 5);
    pointer(lbSvg, "pointerup", 5, 5);
    expect(clickThroughCount).toBe(1);

    // Detach unwires pointer handlers on the fullscreen surface but leaves
    // the card rects + overlays untouched.
    detach();
    pointer(lbSvg, "pointerdown", 20, 20);
    pointer(lbSvg, "pointermove", 100, 100);
    pointer(lbSvg, "pointerup", 100, 100);
    // No new rect added — the listeners are gone.
    expect(handle.getRegions()).toHaveLength(1);
  });

  it("deletes a rectangle on interior click without firing a lightbox click", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const figure = figures[0]!;
    let clickCount = 0;
    figure.addEventListener("click", () => {
      clickCount++;
    });
    const svg = overlaySvg(figure);
    // Draw a rect first.
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointermove", 50, 50);
    pointer(svg, "pointerup", 50, 50);
    expect(handle.getRegions()).toHaveLength(1);
    // Click inside it → delete, not lightbox.
    pointer(svg, "pointerdown", 30, 30);
    pointer(svg, "pointerup", 30, 30);
    expect(handle.getRegions()).toEqual([]);
    expect(clickCount).toBe(0);
  });
});

function drag(svg: SVGSVGElement, from: [number, number], to: [number, number]): void {
  pointer(svg, "pointerdown", from[0], from[1]);
  pointer(svg, "pointermove", to[0], to[1]);
  pointer(svg, "pointerup", to[0], to[1]);
}

function labels(figure: HTMLElement): string[] {
  return Array.from(overlaySvg(figure).querySelectorAll("text.region-label-text")).map((t) => t.textContent ?? "");
}

describe("region overlay — numbering is 1-based and unique across draw and addRegion", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("numbers a dragged rect then an added rect [1, 2], and setCaption(2) lands on the second", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    drag(overlaySvg(figures[0]!), [10, 10], [40, 40]);
    handle.addRegion({ x: 50, y: 50, w: 30, h: 30 });

    expect(handle.getRegions().map((r) => r.index)).toEqual([1, 2]);
    handle.setCaption(2, "second");
    handle.setCaption(1, "first");
    expect(handle.getRegions().map((r) => [r.index, r.caption])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    expect(labels(figures[0]!)).toEqual(["[1]", "[2]"]);
    expect(serializeRegions(handle.getRegions())).toMatch(/- \[1\] .*first\n- \[2\] .*second/);
  });

  it("keeps the numbering dense and captions attached after a delete, then continues from the end", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const svg = overlaySvg(figures[0]!);
    drag(svg, [5, 5], [25, 25]);
    drag(svg, [40, 40], [60, 60]);
    drag(svg, [70, 70], [90, 90]);
    handle.setCaption(1, "a");
    handle.setCaption(2, "b");
    handle.setCaption(3, "c");
    // Delete the middle rect by clicking inside it.
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointerup", 50, 50);
    expect(handle.getRegions().map((r) => [r.index, r.caption])).toEqual([
      [1, "a"],
      [2, "c"],
    ]);
    handle.addRegion({ x: 0, y: 0, w: 10, h: 10 });
    expect(handle.getRegions().map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("restarts numbering at 1 after clear()", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    drag(overlaySvg(figures[0]!), [10, 10], [40, 40]);
    handle.clear();
    expect(handle.getRegions()).toEqual([]);
    expect(overlaySvg(figures[0]!).querySelectorAll("rect.region-rect")).toHaveLength(0);
    drag(overlaySvg(figures[1]!), [20, 20], [60, 60]);
    expect(handle.getRegions().map((r) => r.index)).toEqual([1]);
  });
});

describe("region overlay — resize, cancel, early draw and repeated setup", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resizes from the right/bottom edge and from the left/top corner, clamped to MIN_SIZE and the source bounds", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const svg = overlaySvg(figures[0]!);
    drag(svg, [20, 20], [60, 60]); // rect x20 y20 w40 h40

    drag(svg, [60, 60], [80, 90]); // bottom-right corner
    expect(handle.getRegions()[0]).toMatchObject({ x: 20, y: 20, w: 60, h: 70 });

    drag(svg, [20, 20], [10, 15]); // top-left corner
    expect(handle.getRegions()[0]).toMatchObject({ x: 10, y: 15, w: 70, h: 75 });

    drag(svg, [80, 50], [5, 50]); // right edge dragged past the left edge -> MIN_SIZE
    expect(handle.getRegions()[0]!.w).toBe(4);
    expect(handle.getRegions()[0]!.x).toBe(10);

    drag(svg, [14, 50], [500, 50]); // right edge far past the image -> clamped to the source width
    const r = handle.getRegions()[0]!;
    expect(r.x + r.w).toBeLessThanOrEqual(100);
  });

  it("does not click through, and abandons a half-drawn rect, when the pointer is cancelled", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    let clicks = 0;
    figures[0]!.addEventListener("click", () => clicks++);
    const svg = overlaySvg(figures[0]!);

    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointercancel", 10, 10); // cancelled before any movement: not a click
    expect(clicks).toBe(0);

    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointermove", 60, 60); // rect promoted and growing
    expect(handle.getRegions()).toHaveLength(1);
    pointer(svg, "pointercancel", 60, 60);
    expect(handle.getRegions()).toEqual([]);
    expect(overlaySvg(figures[0]!).querySelectorAll("rect.region-rect")).toHaveLength(0);
    expect(clicks).toBe(0);

    // The overlay is usable again afterwards.
    drag(svg, [10, 10], [50, 50]);
    expect(handle.getRegions().map((r) => r.index)).toEqual([1]);
  });

  it("keeps a cancelled resize at its last geometry", () => {
    const { card, figures } = buildCard();
    const handle = enableRegionOverlays(card);
    const svg = overlaySvg(figures[0]!);
    drag(svg, [20, 20], [60, 60]);
    pointer(svg, "pointerdown", 60, 60);
    pointer(svg, "pointermove", 70, 70);
    pointer(svg, "pointercancel", 70, 70);
    expect(handle.getRegions()[0]).toMatchObject({ w: 50, h: 50 });
    // ...and the gesture is over: further movement does nothing.
    pointer(svg, "pointermove", 90, 90);
    expect(handle.getRegions()[0]).toMatchObject({ w: 50, h: 50 });
  });

  it("ignores drawing until the image has loaded (no source size yet)", () => {
    const { card, figures } = buildCard({ naturalW: 0, naturalH: 0 });
    const handle = enableRegionOverlays(card);
    drag(overlaySvg(figures[0]!), [10, 10], [50, 50]);
    expect(handle.getRegions()).toEqual([]);
  });

  it("returns the existing handle, and does not nest a second stage or stack listeners, on a repeated enable", () => {
    const { card, figures } = buildCard();
    const first = enableRegionOverlays(card);
    const second = enableRegionOverlays(card);
    expect(second).toBe(first);
    expect(card.querySelectorAll(".region-stage")).toHaveLength(3);
    expect(card.querySelectorAll(".region-overlay")).toHaveLength(3);

    drag(overlaySvg(figures[0]!), [10, 10], [50, 50]);
    expect(first.getRegions()).toHaveLength(1); // one listener set -> one rect, not two
  });

  it("does not cache a handle for a card with no figures, so a later enable can wire it", () => {
    document.body.innerHTML = `<div class="card"><div class="imgs"></div></div>`;
    const card = document.body.querySelector(".card") as HTMLElement;
    const empty = enableRegionOverlays(card);
    expect(empty.getRegions()).toEqual([]);
    const figure = document.createElement("figure");
    figure.dataset["src"] = "/x.png";
    figure.innerHTML = "<img alt='' />";
    card.querySelector(".imgs")!.appendChild(figure);
    expect(enableRegionOverlays(card)).not.toBe(empty);
  });
});

describe("region overlay — secondary views", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function lightboxParts(): { img: HTMLImageElement; svg: SVGSVGElement } {
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: 100, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 100, configurable: true });
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    img.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => "",
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.append(img, svg);
    return { img, svg };
  }

  it("clears the rects it painted from the caller's <svg> on detach, and detach is idempotent", () => {
    const { card } = buildCard();
    const handle = enableRegionOverlays(card);
    handle.addRegion({ x: 10, y: 10, w: 30, h: 30 });
    const { img, svg } = lightboxParts();
    const detach = handle.addView(img, svg);
    expect(svg.querySelectorAll("rect.region-rect")).toHaveLength(1);

    detach();
    expect(svg.childNodes).toHaveLength(0);
    expect(() => detach()).not.toThrow();
    handle.addRegion({ x: 50, y: 50, w: 20, h: 20 });
    expect(svg.childNodes).toHaveLength(0); // a detached view is no longer repainted
  });

  it("supports attaching the same surface twice in succession without duplicating listeners", () => {
    const { card } = buildCard();
    const handle = enableRegionOverlays(card);
    const { img, svg } = lightboxParts();
    handle.addView(img, svg)();
    handle.addView(img, svg);
    drag(svg, [10, 10], [50, 50]);
    expect(handle.getRegions()).toHaveLength(1);
  });

  it("removes the pending image-load listener on detach", () => {
    const { card } = buildCard();
    const handle = enableRegionOverlays(card);
    const { img, svg } = lightboxParts();
    Object.defineProperty(img, "complete", { value: false, configurable: true });
    const removed: string[] = [];
    const originalRemove = img.removeEventListener.bind(img);
    img.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (originalRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof img.removeEventListener;
    handle.addView(img, svg)();
    expect(removed).toContain("load");
  });
});

function captionTexts(figure: HTMLElement): string[] {
  return Array.from(overlaySvg(figure).querySelectorAll("text.region-caption-text")).map((t) => t.textContent ?? "");
}

describe("captionPreviewText", () => {
  it("collapses whitespace and trims", () => {
    expect(captionPreviewText("  missing \n  CTA\tbutton ")).toBe("missing CTA button");
    expect(captionPreviewText(undefined)).toBe("");
    expect(captionPreviewText("   ")).toBe("");
  });

  it("keeps a caption at the limit whole and cuts a longer one with an ellipsis", () => {
    const exact = "x".repeat(CAPTION_PREVIEW_MAX_CHARS);
    expect(captionPreviewText(exact)).toBe(exact);
    const cut = captionPreviewText("y".repeat(CAPTION_PREVIEW_MAX_CHARS + 20));
    expect(cut.length).toBe(CAPTION_PREVIEW_MAX_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("region overlay — caption preview on the image", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("paints no preview until a caption is typed, then updates as the caption changes and clears when emptied", () => {
    const { card, figures } = buildCard({ naturalW: 400, naturalH: 200, displayW: 400, displayH: 200 });
    const handle = enableRegionOverlays(card);
    drag(overlaySvg(figures[0]!), [10, 10], [60, 60]);
    expect(captionTexts(figures[0]!)).toEqual([]);
    handle.setCaption(1, "CTA missing");
    expect(captionTexts(figures[0]!)).toEqual(["CTA missing"]);
    handle.setCaption(1, "CTA missing here");
    expect(captionTexts(figures[0]!)).toEqual(["CTA missing here"]);
    handle.setCaption(1, "");
    expect(captionTexts(figures[0]!)).toEqual([]);
  });

  it("shows the same preview on every figure of the triplet, and the badge keeps its own label", () => {
    const { card, figures } = buildCard({ naturalW: 400, naturalH: 200, displayW: 400, displayH: 200 });
    const handle = enableRegionOverlays(card);
    drag(overlaySvg(figures[1]!), [10, 10], [60, 60]);
    handle.setCaption(1, "shifted");
    for (const figure of figures) {
      expect(captionTexts(figure)).toEqual(["shifted"]);
      expect(labels(figure)).toEqual(["[1]"]);
    }
  });

  it("labels each region with its own caption and only the captioned ones", () => {
    const { card, figures } = buildCard({ naturalW: 400, naturalH: 200, displayW: 400, displayH: 200 });
    const handle = enableRegionOverlays(card);
    drag(overlaySvg(figures[0]!), [5, 5], [25, 25]);
    drag(overlaySvg(figures[0]!), [40, 40], [60, 60]);
    handle.setCaption(2, "second only");
    expect(captionTexts(figures[0]!)).toEqual(["second only"]);
  });

  it("is a plain label: no pointer events, so drag, resize and delete are unaffected", () => {
    const { card, figures } = buildCard({ naturalW: 400, naturalH: 200, displayW: 400, displayH: 200 });
    const handle = enableRegionOverlays(card);
    const svg = overlaySvg(figures[0]!);
    drag(svg, [10, 10], [60, 60]);
    handle.setCaption(1, "annotated");
    for (const el of svg.querySelectorAll(".region-caption-bg, .region-caption-text")) {
      expect(el.getAttribute("pointer-events")).toBe("none");
    }
    // Resize by dragging the right edge with the preview present.
    pointer(svg, "pointerdown", 60, 30);
    pointer(svg, "pointermove", 80, 30);
    pointer(svg, "pointerup", 80, 30);
    expect(handle.getRegions()[0]).toMatchObject({ x: 10, w: 70, caption: "annotated" });
    // Delete by clicking inside; the preview goes with its region.
    pointer(svg, "pointerdown", 30, 30);
    pointer(svg, "pointerup", 30, 30);
    expect(handle.getRegions()).toEqual([]);
    expect(captionTexts(figures[0]!)).toEqual([]);
  });

  const captionBox = (figure: HTMLElement): { x: number; y: number; width: number } => {
    const bg = overlaySvg(figure).querySelector("rect.region-caption-bg")!;
    return {
      x: Number(bg.getAttribute("x")),
      y: Number(bg.getAttribute("y")),
      width: Number(bg.getAttribute("width")),
    };
  };
  const badgeBox = (figure: HTMLElement): { x: number; y: number; width: number } => {
    const bg = overlaySvg(figure).querySelector("rect.region-label-bg")!;
    return {
      x: Number(bg.getAttribute("x")),
      y: Number(bg.getAttribute("y")),
      width: Number(bg.getAttribute("width")),
    };
  };

  it("sits directly right of the badge on the same line, and never over the badge", () => {
    const { card, figures } = buildCard({ naturalW: 400, naturalH: 200, displayW: 400, displayH: 200 });
    const handle = enableRegionOverlays(card);
    handle.addRegion({ x: 20, y: 30, w: 60, h: 40 });
    handle.setCaption(1, "short");
    const badge = badgeBox(figures[0]!);
    const caption = captionBox(figures[0]!);
    expect(caption.y).toBe(badge.y);
    expect(caption.x).toBe(badge.x + badge.width);
  });

  it("truncates to the room left of the image edge instead of sliding over the badge", () => {
    const { card, figures } = buildCard({ naturalW: 300, naturalH: 200, displayW: 300, displayH: 200 });
    const handle = enableRegionOverlays(card);
    handle.addRegion({ x: 120, y: 30, w: 60, h: 40 });
    handle.setCaption(1, "a caption that is far too long to fit beside the badge here");
    const badge = badgeBox(figures[0]!);
    const caption = captionBox(figures[0]!);
    expect(caption.y).toBe(badge.y);
    expect(caption.x).toBeGreaterThanOrEqual(badge.x + badge.width);
    expect(caption.x + caption.width).toBeLessThanOrEqual(300 + 0.001);
    expect(captionTexts(figures[0]!)[0]!.endsWith("…")).toBe(true);
  });

  it("drops to the line under the badge when a region hugs the right edge", () => {
    const { card, figures } = buildCard({ naturalW: 300, naturalH: 200, displayW: 300, displayH: 200 });
    const handle = enableRegionOverlays(card);
    handle.addRegion({ x: 270, y: 30, w: 25, h: 40 });
    handle.setCaption(1, "edge caption stays readable");
    const badge = badgeBox(figures[0]!);
    const caption = captionBox(figures[0]!);
    expect(caption.y).toBeGreaterThan(badge.y);
    expect(caption.x).toBeGreaterThanOrEqual(0);
    expect(caption.x + caption.width).toBeLessThanOrEqual(300 + 0.001);
    expect(captionTexts(figures[0]!)).toEqual(["edge caption stays readable"]);
  });

  it("truncates to the image width on a very narrow image", () => {
    const { card, figures } = buildCard({ naturalW: 100, naturalH: 100 });
    const handle = enableRegionOverlays(card);
    handle.addRegion({ x: 80, y: 10, w: 15, h: 15 });
    handle.setCaption(1, "a fairly long caption here");
    const caption = captionBox(figures[0]!);
    expect(caption.x).toBeGreaterThanOrEqual(0);
    expect(caption.x + caption.width).toBeLessThanOrEqual(100 + 0.001);
  });
});

describe("region overlay — badge sizing", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("makes the badge wide enough for its `[N]` label (three characters at ~8.4 px plus padding) and wider for [10]", () => {
    const { card, figures } = buildCard({ naturalW: 400, naturalH: 200, displayW: 400, displayH: 200 });
    const handle = enableRegionOverlays(card);
    for (let i = 0; i < 10; i++) handle.addRegion({ x: 10 + i * 30, y: 10, w: 20, h: 20 });
    const widths = Array.from(overlaySvg(figures[0]!).querySelectorAll("rect.region-label-bg")).map((r) =>
      Number(r.getAttribute("width")),
    );
    expect(widths[0]).toBeGreaterThanOrEqual(3 * 8.4);
    expect(widths[9]).toBeGreaterThan(widths[0]!);
  });
});
