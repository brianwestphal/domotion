# Domotion: cursor / touch / click overlay (proposed)

Requirements for an opt-in API that renders an animated cursor, touch indicators, and click pulses on top of a captured SVG. Origin: DM-277 (filed from DM-272). **Status: design proposal — not yet implemented; awaiting feedback (DM-277 has a FEEDBACK NEEDED note).**

## Use case

Demo authors want the rendered SVG to show *what the user did* — where the mouse moved, where they clicked, when they scrolled. macOS QuickTime's `record clicks` option is the canonical UX reference: a faint circle pulses at each click location, sized to roughly a fingertip.

The static `30-cursor` html-test fixture exists to verify CSS `cursor: <value>` doesn't break capture; it is **not** the target of this overlay. The overlay is a separate animation layer added to demos that opt in.

## API surface (proposed)

A new optional config on `generateAnimatedSvg(frames, opts)`:

```ts
type CursorEvent =
  | { type: "move";   t: number; x: number; y: number; pointer: "mouse" | "touch"; touchId?: number }
  | { type: "click";  t: number; x: number; y: number; button: "left" | "middle" | "right" }
  | { type: "scroll"; t: number; x: number; y: number; dx: number; dy: number };

interface CursorOverlay {
  events: CursorEvent[];
  /** ms; pulse duration after a click. Default 300. */
  clickPulseMs?: number;
  /** Cursor glyph: "arrow" (Apple-style), "ring" (minimal), or "fingerprint" (touch). */
  glyph?: "arrow" | "ring" | "fingerprint";
}

generateAnimatedSvg(frames, { transitions, cursorOverlay });
```

Overlay output is appended to the top-level SVG as a single `<g class="cursor-overlay">` group, painted last so it sits above the frame content.

## Rendering primitives

- **Mouse pointer**: a small Apple-style arrow path (or a `<circle>` ring for minimalism). Position animated via `<animateMotion>` along a `<path>` built from the captured `move` events. CSS `display` toggles when the pointer goes off-screen.
- **Touch indicator**: a 32-px translucent circle. Multi-touch fingers each get their own indicator (keyed by `touchId`).
- **Click pulse**: a `<circle>` that scales from 0 to ~32px and fades out over `clickPulseMs`, color-coded by button (left = blue, middle = green, right = red, customizable later). Implemented via inline `<animate>` for `r` and `opacity`.
- **Scroll**: a faint directional arrow at `(x, y)` for the duration of the scroll-event time slice. Probably a v2 — punt unless there's demand.

## Capture-side helper (proposed)

Demo scripts that drive a Playwright `page` can opt in to automatic event recording:

```ts
const recorder = new CursorRecorder(page);
recorder.start();
await page.mouse.move(...);
await page.mouse.click(...);
await recorder.stop();
const events = recorder.events;
generateAnimatedSvg(frames, { cursorOverlay: { events } });
```

`CursorRecorder` taps `page.on('console')` (or a more direct browser-event hook) to record every `mousemove` / `click` / `wheel` and timestamps relative to the recording start. The exact hook is TBD — Playwright doesn't expose a `mousemove`-event hook directly, so the recorder may need to inject a script that posts events via `console.log`.

## Open questions (FEEDBACK NEEDED on DM-277)

1. **Glyph choice**: Apple-style arrow path? Material Design arrow? A simple ring (most demos don't want a literal cursor — they want to show *where* attention is)?
2. **Multi-pointer behavior**: do mouse events and touch events render simultaneously, or is the demo always one or the other? Most demos won't mix, but the type allows it.
3. **Event recording**: should `CursorRecorder` ship with the package, or is the API surface enough and authors record events however they want?
4. **Scroll visualization**: is the directional-arrow approach acceptable, or is "show the underlying scrolled content moving" sufficient?
5. **Click colors**: hard-code button = color, or expose a `clickPalette: { left: string; ...}` config?
6. **Default behavior**: when does the overlay default to ON vs require opt-in?

The proposed design above defaults all of these to "v1 simple"; the FEEDBACK on the ticket asks the user to confirm or redirect.

## Edge cases / out of scope

- **Pinch-zoom / rotation gestures**: not modeled. v1 only supports tap/drag.
- **Pen / stylus pointers**: same as mouse for now.
- **Hover-only highlighting** (no click): the move events alone cover this — the pointer just sits where the user was hovering for that frame.
- **Recording from real user sessions** (not synthesized via Playwright): out of scope; a future ticket could integrate with a JavaScript event recorder.

## Tests

- Once implemented, two unit tests:
  - Snapshot test: an overlay with a known event timeline produces deterministic SVG output.
  - Integration test: `generateAnimatedSvg` accepts the overlay config and returns SVG with a `class="cursor-overlay"` group at the end.
- One features-suite fixture: a 3-frame demo with a click pulse mid-frame, verified visually.
