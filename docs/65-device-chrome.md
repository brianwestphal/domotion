# 65 — Device chrome (`--chrome <device>`)

Status: **partially shipped** (DM-1206). The `phone` device is implemented;
`browser` / `window` are a tracked follow-up.

`domotion capture … --chrome <device>` wraps a capture in a hand-drawn device
bezel — a phone body, a browser window, etc. — so a marketing asset reads as
"this is a real app on a real device" without a separate image editor.

## Usage

```sh
domotion capture mobile-screen.html \
  --width 390 --height 844 --mobile \
  --chrome phone \
  -o phone-screen.svg
```

The capture is taken at `--width × --height` (the inner **screen** size); the
bezel adds an even rim, so the output grows (phone: a 390×844 screen → a
418×872 framed SVG). An unknown device name is a hard error listing the
supported set.

## Devices

| Device | Status | Bezel |
|---|---|---|
| `phone` | shipped | iPhone-class: rounded titanium body, dynamic-island notch, home indicator |
| `browser` | follow-up | macOS-style window: traffic-light buttons + a URL bar |
| `window` | follow-up | plain rounded window with a title bar |

## How it works

- **`src/render/device-chrome.ts`** owns the bezel geometry and exports
  `wrapInDeviceChrome(captureSvg, device, screenW, screenH) → { svg, width,
  height }`, plus `isDeviceChrome()` / `DEVICE_CHROMES` for validation. It is
  re-exported from the render barrel and the package root.
- The CLI (`src/cli/capture.ts`) validates `--chrome` up front, then wraps the
  finished SVG **after** rendering and **before** the optimize pass.
- **Nesting, not re-rendering.** The bezel strips the capture's outer `<svg>`
  and re-nests its body as a child `<svg>` offset by the rim, clipped to the
  rounded screen. This is deliberate: re-rendering the element tree through a
  second path-render dropped the host system font to `.notdef` tofu (seen
  building the phone demo, DM-217). Nesting reuses the exact glyph paths the
  bare capture produced.
- **Cross-platform.** The bezel is pure SVG primitives (rects, no text), so it
  carries no system-font dependency and renders identically on macOS / Linux /
  Windows — unlike the capture it wraps, which is calibrated per-platform.

## Programmatic API

Library callers wrap a capture the same way:

```ts
import { captureElementTree, elementTreeToSvg, wrapInDeviceChrome } from "domotion-svg";

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });
const capture = elementTreeToSvg(tree, 390, 844);
const { svg, width, height } = wrapInDeviceChrome(capture, "phone", 390, 844);
```

## Scope notes

- This replaces the hand-rolled phone bezel that previously lived in
  `site/scripts/demos/phone-screen/build-phone-screen.ts` (now retired) and the
  inline preview in `site/scripts/build-install-demo.ts` (which can be migrated
  to `wrapInDeviceChrome` when next touched).
- Combining `--chrome` with `--scroll` (an animated scroll capture nested in a
  bezel) nests an animated inner `<svg>` — it should work mechanically but is
  not yet a verified path; treat it as out of scope until tested.
- The `browser` / `window` device designs are subjective (traffic-light placement,
  URL-bar styling, light vs dark), so they're left as a follow-up rather than
  guessed at here.
