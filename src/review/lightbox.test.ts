// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { applyLightboxAspect, createLightboxOverlayBinding } from "./lightbox.js";
import type { OverlayHandle } from "./region-overlay.js";

function image(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  const img = document.createElement("img");
  Object.defineProperty(img, "naturalWidth", { value: naturalWidth, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: naturalHeight, configurable: true });
  return img;
}

describe("applyLightboxAspect", () => {
  it("marks a taller-than-wide image, and unmarks a wide one", () => {
    const lightbox = document.createElement("div");
    applyLightboxAspect(lightbox, image(100, 300));
    expect(lightbox.classList.contains("tall")).toBe(true);
    applyLightboxAspect(lightbox, image(300, 100));
    expect(lightbox.classList.contains("tall")).toBe(false);
  });

  it("waits for the first load when the size is not known yet, then applies it once", () => {
    const lightbox = document.createElement("div");
    const img = image(0, 0);
    applyLightboxAspect(lightbox, img);
    expect(lightbox.classList.contains("tall")).toBe(false);
    Object.defineProperty(img, "naturalWidth", { value: 50, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 90, configurable: true });
    img.dispatchEvent(new Event("load"));
    expect(lightbox.classList.contains("tall")).toBe(true);
    // `once`: a later load with different dimensions is ignored.
    Object.defineProperty(img, "naturalWidth", { value: 90, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 50, configurable: true });
    img.dispatchEvent(new Event("load"));
    expect(lightbox.classList.contains("tall")).toBe(true);
  });
});

describe("createLightboxOverlayBinding", () => {
  function fakeHandle() {
    const detaches: Array<ReturnType<typeof vi.fn>> = [];
    const handle = {
      addView: vi.fn(() => {
        const detach = vi.fn();
        detaches.push(detach);
        return detach;
      }),
    } as unknown as OverlayHandle;
    return { handle, detaches };
  }

  it("attaches once per handle, keeps the view across re-attach of the same handle, and switches handles cleanly", () => {
    const img = document.createElement("img");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const onClickThrough = vi.fn();
    const binding = createLightboxOverlayBinding(img, svg, onClickThrough);
    const a = fakeHandle();
    const b = fakeHandle();

    binding.attach(a.handle);
    binding.attach(a.handle); // arrow-key navigation within one card: no churn
    expect(a.handle.addView).toHaveBeenCalledTimes(1);
    expect(a.handle.addView).toHaveBeenCalledWith(img, svg, onClickThrough);

    binding.attach(b.handle); // hop to another card
    expect(a.detaches[0]).toHaveBeenCalledTimes(1);
    expect(b.handle.addView).toHaveBeenCalledTimes(1);

    binding.detach();
    binding.detach(); // idempotent
    expect(b.detaches[0]).toHaveBeenCalledTimes(1);

    binding.attach(a.handle); // re-openable after a close
    expect(a.handle.addView).toHaveBeenCalledTimes(2);
  });
});
