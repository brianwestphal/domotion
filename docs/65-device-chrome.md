# 65 — Device chrome (`--chrome <device>`)

Status: **shipped** (DM-1206 phone; DM-1211 browser / window; DM-1212 light/dark theme).

`domotion capture … --chrome <device>` wraps a capture in a hand-drawn device
bezel — a phone body, a browser window, a plain app window — so a marketing
asset reads as "this is a real app on a real device" without a separate image
editor.

> **`capture --chrome` is static; animated nesting now has a path.** The
> `--chrome` flag wraps a **single still capture**. But the underlying
> `wrapInDeviceChrome` *nests* the screen as a child `<svg>` (it doesn't
> re-render), so it preserves animation when given an animated screen — exposed
> via the `device-mockup` template's `screenSvg` param and, more generally, the
> `composite` primitive / `domotion composite` verb (DM-1323, doc 77), which
> draws this bezel around an *animated* layer (a cast, a scroll capture, another
> animated SVG) and keeps it animating. The terminal-window-on-a-desktop demo is
> `examples/composite-desktop.ts`.

## Usage

```sh
# Phone bezel around a mobile capture.
domotion capture mobile-screen.html --width 390 --height 844 --mobile --chrome phone -o phone.svg

# Browser window with a URL in the address bar.
domotion capture pricing.html --width 960 --height 410 --chrome browser --chrome-label "domotion.dev/pricing" -o pricing.svg

# Plain app window with a centered title.
domotion capture editor.html --width 720 --height 360 --chrome window --chrome-label "capture.ts — Domotion" -o editor.svg
```

The capture is taken at `--width × --height` (the inner **screen** size); the
bezel grows the output — `phone` adds an even rim on every side (390×844 →
418×872); `browser` / `window` add a chrome bar on top only (960×600 → 960×644
for browser, 960×636 for window). An unknown device name is a hard error
listing the supported set.

**Bezel furniture scales with the screen (DM-1559 / DM-1577).** The rim / bar
thicknesses, traffic-light dots, and corner radii above are the sizes at the
reference screen; for a larger screen the furniture is scaled up so a big / tall
capture (e.g. a `reel` 1080×1920 format screen) doesn't get a hairline rim or a
too-thin title bar. The factor is `s = max(1, min(screenW, screenH) / REF)` —
`REF = 390` for `phone` and `600` for `browser`/`window`
(`src/render/device-chrome.ts`) — so at or below the reference the geometry is
unchanged, and above it the whole bezel grows proportionally.

`--chrome-label <text>` sets the **browser** URL bar address or the **window**
title; it's ignored by `phone`, and omitting it leaves an empty URL pill /
blank title bar.

`--chrome-theme <dark|light>` (DM-1212) themes the **browser** / **window**
bezel — `dark` (default, matching the demo gallery) or `light` for captures of
light-themed pages. It's an explicit flag rather than derived from
`--color-scheme`, since the page's color scheme and the bezel you want around it
are independent (you might capture a light page but want dark chrome, or vice
versa). `phone` is theme-agnostic (titanium body). Light theme uses a
`#e8e8ea` bar, a white screen backdrop, and a bordered white URL pill;
traffic-light colors are unchanged in both.

## Devices

| Device | Bezel |
|---|---|
| `phone` | iPhone-class: rounded titanium body, dynamic-island notch, home indicator. Pure shapes (no text). |
| `browser` | macOS-style window: rounded corners, three traffic-light buttons, and a URL pill with a lock + the `--chrome-label` address. 44px bar. |
| `window` | plain rounded window: traffic-light buttons + a centered `--chrome-label` title. 36px bar. |

## How it works

- **`src/render/device-chrome.ts`** owns the bezel geometry and exports
  `wrapInDeviceChrome(captureSvg, device, screenW, screenH, opts?) → { svg,
  width, height }` (where `opts.label` is the browser URL / window title), plus
  `isDeviceChrome()` / `DEVICE_CHROMES` for validation. It is re-exported from
  the render barrel and the package root.
- The CLI (`src/cli/capture.ts`) validates `--chrome` up front, then wraps the
  finished SVG **after** rendering and **before** the optimize pass.
- **Nesting, not re-rendering.** The bezel strips the capture's outer `<svg>`
  and re-nests its body as a child `<svg>` offset by the rim, clipped to the
  rounded screen. This is deliberate: re-rendering the element tree through a
  second path-render dropped the host system font to `.notdef` tofu (seen
  building the phone demo, DM-217). Nesting reuses the exact glyph paths the
  bare capture produced.
- **Cross-platform.** The bezel is pure SVG primitives (rects, paths). The one
  exception is the browser/window **label** (`--chrome-label`), drawn as a
  single `<text>` with a generic font stack — it's decoration painted live by
  the SVG viewer, not captured content, so a little cross-viewer font variance
  on a URL/title string is acceptable. Everything else carries no system-font
  dependency, so the bezel renders consistently on macOS / Linux / Windows —
  unlike the capture it wraps, which is calibrated per-platform.

## Programmatic API

Library callers wrap a capture the same way:

```ts
import { captureElementTree, elementTreeToSvg, wrapInDeviceChrome } from "domotion-svg";

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });
const capture = elementTreeToSvg(tree, 390, 844);
const { svg, width, height } = wrapInDeviceChrome(capture, "phone", 390, 844);
```

## Scope notes

- This replaces the hand-rolled phone bezels that lived in the legacy site's
  demo/build scripts (the old `site/scripts/demos/phone-screen/` builder and the
  install-demo inline preview), all removed in the DM-1308 site rebuild;
  `wrapInDeviceChrome` is now the single source for device framing.
- Combining `--chrome` with `--scroll` (an animated scroll capture nested in a
  bezel) nests an animated inner `<svg>` — it should work mechanically but is
  not yet a verified path; treat it as out of scope until tested.
- The `browser` / `window` chrome ships `dark` (default) and `light` themes
  (DM-1212) via `--chrome-theme`. Auto-deriving the theme from the capture's
  dominant background, if ever wanted, would be a further option.
