// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { enableRegionOverlays } from "./review-region-overlay.js";

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
