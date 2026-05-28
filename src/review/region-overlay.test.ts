// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { enableRegionOverlays } from "./region-overlay.js";

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
    lbImg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => "" });
    lbStage.appendChild(lbImg);
    const lbSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    lbStage.appendChild(lbSvg);
    let clickThroughCount = 0;
    const detach = handle.addView(lbImg, lbSvg, () => { clickThroughCount++; });

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
