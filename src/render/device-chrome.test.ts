/** Unit tests for the device-chrome wrapper (DM-1206). */

import { describe, it, expect } from "vitest";
import { wrapInDeviceChrome, isDeviceChrome, DEVICE_CHROMES, isChromeTheme, CHROME_THEMES } from "./device-chrome.js";

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

const DESKTOP = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600"><rect width="960" height="600" fill="#0d1117"/><text x="10" y="20">DESKTOP_CONTENT</text></svg>`;

describe("device-chrome: browser / window (DM-1211)", () => {
  it("knows the new devices", () => {
    expect(DEVICE_CHROMES).toEqual(["phone", "browser", "window"]);
    expect(isDeviceChrome("browser")).toBe(true);
    expect(isDeviceChrome("window")).toBe(true);
  });

  it("browser grows by a 44px chrome bar in height only (960×600 → 960×644)", () => {
    const { width, height, svg } = wrapInDeviceChrome(DESKTOP, "browser", 960, 600);
    expect(width).toBe(960);
    expect(height).toBe(644);
    expect(svg).toContain(`viewBox="0 0 960 644"`);
  });

  it("window grows by a 36px title bar (960×600 → 960×636)", () => {
    const { width, height } = wrapInDeviceChrome(DESKTOP, "window", 960, 600);
    expect(width).toBe(960);
    expect(height).toBe(636);
  });

  it("draws three traffic-light buttons (the macOS colors) on both", () => {
    for (const device of ["browser", "window"] as const) {
      const { svg } = wrapInDeviceChrome(DESKTOP, device, 960, 600);
      expect(svg).toContain(`fill="#ff5f56"`);
      expect(svg).toContain(`fill="#ffbd2e"`);
      expect(svg).toContain(`fill="#27c93f"`);
    }
  });

  it("nests the capture at the bar offset (no re-render)", () => {
    const { svg } = wrapInDeviceChrome(DESKTOP, "browser", 960, 600);
    expect(svg).toContain("DESKTOP_CONTENT");
    expect(svg).toMatch(/<svg x="0" y="44" width="960" height="600"/);
    expect((svg.match(/<svg/g) ?? []).length).toBe(2);
  });

  it("browser renders the label as the URL (escaped), with no label → no <text>", () => {
    const labeled = wrapInDeviceChrome(DESKTOP, "browser", 960, 600, { label: "acme.dev/a?b=1&c=2" });
    expect(labeled.svg).toContain("acme.dev/a?b=1&amp;c=2");
    expect(labeled.svg).toMatch(/<text[^>]*>acme\.dev/);
    const bare = wrapInDeviceChrome(DESKTOP, "browser", 960, 600);
    // No label → only the nested capture's <text>, none for the URL.
    expect((bare.svg.match(/<text/g) ?? []).length).toBe(1);
  });

  it("window centers the label as a title", () => {
    const { svg } = wrapInDeviceChrome(DESKTOP, "window", 960, 600, { label: "Untitled" });
    expect(svg).toMatch(/<text[^>]*text-anchor="middle"[^>]*>Untitled/);
  });
});

describe("device-chrome: light/dark theme (DM-1212)", () => {
  it("defaults to the dark palette (dark bar, dark screen backdrop)", () => {
    for (const device of ["browser", "window"] as const) {
      const { svg } = wrapInDeviceChrome(DESKTOP, device, 960, 600);
      expect(svg).toContain(`fill="#2b2b2e"`); // dark bar
      expect(svg).toContain(`fill="#0d1117"`); // dark screen backdrop
    }
  });

  it("theme:light swaps to the light palette (light bar, white screen backdrop) and adds a pill border", () => {
    const { svg } = wrapInDeviceChrome(DESKTOP, "browser", 960, 600, { theme: "light" });
    expect(svg).toContain(`fill="#e8e8ea"`);     // light bar
    expect(svg).toContain(`fill="#ffffff"`);     // white screen backdrop / pill
    expect(svg).not.toContain(`fill="#2b2b2e"`); // no dark bar
    // Light theme gives the white URL pill a border for contrast on the light bar.
    expect(svg).toMatch(/rx="11" fill="#ffffff" stroke="#d1d1d6"/);
  });

  it("theme is dimension- and content-neutral (only colors change)", () => {
    const dark = wrapInDeviceChrome(DESKTOP, "browser", 960, 600, { theme: "dark", label: "x" });
    const light = wrapInDeviceChrome(DESKTOP, "browser", 960, 600, { theme: "light", label: "x" });
    expect(light.width).toBe(dark.width);
    expect(light.height).toBe(dark.height);
    // Same capture nested either way.
    expect(light.svg).toContain("DESKTOP_CONTENT");
  });

  it("isChromeTheme guards the supported set", () => {
    expect(CHROME_THEMES).toEqual(["dark", "light"]);
    expect(isChromeTheme("light")).toBe(true);
    expect(isChromeTheme("dark")).toBe(true);
    expect(isChromeTheme("sepia")).toBe(false);
  });
});
