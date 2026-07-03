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

describe("device-chrome: format-aware phone bezel scaling (DM-1559)", () => {
  // A format (`--format reel`) sizes the inner SCREEN and the bezel wraps AROUND
  // it. The rim/radius/notch are tuned for a ~390-wide phone, so a large (reel)
  // screen scales the geometry up: `s = max(1, min(w,h)/390)`.

  it("keeps the calibrated bezel byte-identical at/below the reference size", () => {
    // s === 1, so the output must equal the pre-scaling geometry exactly.
    const { svg } = wrapInDeviceChrome(CAPTURE, "phone", 390, 844);
    // 14px rim, 56 radius, 42 inner radius, 3/1.5 rim-highlight, 112×30 notch,
    // 130×5 home indicator — the authored numbers.
    expect(svg).toMatch(/<rect x="14" y="14" width="390" height="844" rx="42"/);
    expect(svg).toContain('rx="56" fill="#1c1c1e"');
    expect(svg).toContain('x="3" y="3"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain('width="112" height="30" rx="15" fill="#000"');
    expect(svg).toContain('width="130" height="5" rx="2.5"');
  });

  it("a smaller-than-reference screen also stays on the calibrated (floored) bezel", () => {
    // min(300,650)/390 < 1 → floored to 1 → same 14px rim as before.
    const { width, height } = wrapInDeviceChrome(CAPTURE, "phone", 300, 650);
    expect(width).toBe(300 + 28);
    expect(height).toBe(650 + 28);
  });

  it("scales the rim/radius/notch proportionally for a reel-sized screen (1080×1920)", () => {
    const { width, height, svg } = wrapInDeviceChrome(CAPTURE, "phone", 1080, 1920);
    // s = min(1080,1920)/390 = 1080/390 ≈ 2.769 → rim 39, radius 155.
    expect(width).toBe(1080 + 39 * 2);   // 1158
    expect(height).toBe(1920 + 39 * 2);  // 1998
    expect(svg).toContain(`viewBox="0 0 1158 1998"`);
    // Outer body corner radius scales (round(56·2.769) = 155), not the fixed 56.
    expect(svg).toContain('rx="155" fill="#1c1c1e"');
    // Screen nested at the scaled rim offset, inner radius round(56·s)−39 = 116.
    expect(svg).toMatch(/<svg x="39" y="39" width="1080" height="1920"/);
    expect(svg).toContain('rx="116"');
    // The notch grows too (round(112·s)=310, round(30·s)=83).
    expect(svg).toContain('width="310" height="83"');
    // Still exactly two <svg> opens (bezel + nested capture) and no bezel text.
    expect((svg.match(/<svg/g) ?? []).length).toBe(2);
  });

  it("bases the scale on the SHORTER screen dimension (so a portrait screen scales by width)", () => {
    // Portrait reel: min is the width; a hypothetical landscape screen of the
    // same area would scale by its (shorter) height instead — the bezel tracks
    // the narrow dimension, matching how a phone's rim relates to its width.
    const portrait = wrapInDeviceChrome(CAPTURE, "phone", 1080, 1920);
    const landscape = wrapInDeviceChrome(CAPTURE, "phone", 1920, 1080);
    // Both share min = 1080 → same rim (39) → same growth on each axis.
    expect(portrait.width - 1080).toBe(landscape.height - 1080);
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

  it("DM-1577: scales the browser/window chrome for a large (tall) capture; ≤600-min is byte-identical", () => {
    // Byte-identical at the 600-tall default (s === 1).
    expect(wrapInDeviceChrome(DESKTOP, "browser", 960, 600).height).toBe(644); // 44px bar
    expect(wrapInDeviceChrome(DESKTOP, "browser", 400, 300).height).toBe(344); // still 44px (min 300 < 600)
    // A tall reel screen (min 1080) scales by 1080/600 = 1.8.
    const reel = wrapInDeviceChrome(DESKTOP, "browser", 1080, 1920);
    expect(reel.height - 1920).toBeCloseTo(44 * 1.8, 1); // bar ~79.2
    expect(reel.svg).toMatch(/r="10\.8" fill="#ff5f56"/);  // traffic dot 6 → 10.8
    // Window title bar scales too (36 → 64.8).
    expect(wrapInDeviceChrome(DESKTOP, "window", 1080, 1920).height - 1920).toBeCloseTo(36 * 1.8, 1);
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
