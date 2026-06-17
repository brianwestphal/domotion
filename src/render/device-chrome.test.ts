/** Unit tests for the device-chrome wrapper (DM-1206). */

import { describe, it, expect } from "vitest";
import { wrapInDeviceChrome, isDeviceChrome, DEVICE_CHROMES } from "./device-chrome.js";

const CAPTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844"><rect width="390" height="844" fill="#0d1117"/><text x="10" y="20">UNIQUE_CONTENT</text></svg>`;

describe("device-chrome (DM-1206)", () => {
  it("knows its supported devices", () => {
    expect(DEVICE_CHROMES).toContain("phone");
    expect(isDeviceChrome("phone")).toBe(true);
    expect(isDeviceChrome("tablet")).toBe(false);
  });

  it("phone bezel grows the canvas by 2×RIM (390×844 → 418×872)", () => {
    const { width, height, svg } = wrapInDeviceChrome(CAPTURE, "phone", 390, 844);
    expect(width).toBe(418);
    expect(height).toBe(872);
    expect(svg).toContain(`viewBox="0 0 418 872"`);
    expect(svg).toContain(`width="418"`);
    expect(svg).toContain(`height="872"`);
  });

  it("NESTS the capture (keeps its content) rather than re-rendering it", () => {
    const { svg } = wrapInDeviceChrome(CAPTURE, "phone", 390, 844);
    // The capture's body survives verbatim — no second path-render.
    expect(svg).toContain("UNIQUE_CONTENT");
    // Nested as an inner <svg> offset by the rim, clipped to the screen.
    expect(svg).toMatch(/<svg x="14" y="14" width="390" height="844"/);
    expect(svg).toContain(`clip-path="url(#phone-screen-clip)"`);
  });

  it("strips the capture's outer <svg> wrapper (no nested duplicate width attrs leak out)", () => {
    const { svg } = wrapInDeviceChrome(CAPTURE, "phone", 390, 844);
    // Exactly two <svg> opens: the outer bezel doc + the one nested capture.
    expect((svg.match(/<svg/g) ?? []).length).toBe(2);
  });

  it("draws bezel furniture (notch + home indicator) as pure rects, no text", () => {
    const { svg } = wrapInDeviceChrome(CAPTURE, "phone", 390, 844);
    // Notch + home indicator rects are present; the only <text> is the nested
    // capture's, not the bezel's (cross-platform: bezel has no fonts).
    expect((svg.match(/<text/g) ?? []).length).toBe(1);
    expect(svg).toContain(`<rect`);
  });

  it("tolerates an XML declaration on the capture", () => {
    const withDecl = `<?xml version="1.0" encoding="UTF-8"?>\n${CAPTURE}`;
    const { svg } = wrapInDeviceChrome(withDecl, "phone", 390, 844);
    expect(svg).toContain("UNIQUE_CONTENT");
    expect((svg.match(/<svg/g) ?? []).length).toBe(2);
  });
});
