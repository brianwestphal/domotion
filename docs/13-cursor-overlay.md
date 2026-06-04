# Domotion: cursor / click overlay

Requirements for an opt-in animated cursor + click pulse layer that paints on top of a captured SVG. Origin: DM-277 (filed from DM-272).

## Use case

Demos record an interaction and want to show *what the user did* — a macOS-style mouse cursor moving across the page, with QuickTime-style click ring pulses at each click. This is the same effect as macOS QuickTime's `record clicks`.

The static `30-cursor` html-test fixture is **not** the target of this overlay. It tests CSS `cursor: <value>` rendering and is unrelated.

## Design (per DM-277 feedback)

- **Pointer style**: macOS arrow (white with black outline). Single pointer at a time — demos don't mix mouse and touch in one timeline.
- **Click feedback**: a circular ring centered on the cursor, colorless (matches QuickTime). The ring scales out and fades.
  - **Primary click**: ring only.
  - **Secondary click**: ring + fill the **right half** of the inner circle with `rgba(0, 0, 0, 0.2)`.
  - **Middle click**: render like primary.
- **Scroll**: not a separate overlay element — the captured content already shows the scroll motion frame-to-frame.
- **Defaults**: overlay is opt-in. Global config per animation; per-event style override allowed.

## Event script (JSON)

The overlay is driven by a sequence of timed events. Times are milliseconds from the start of the animation.

```ts
type CursorEvent =
  | { type: "show";  t: number; x: number; y: number }
  | { type: "move";  t: number; duration?: number;
      to?: { x: number; y: number };
      by?: { dx: number; dy: number };
      selector?: string;
      offset?: { dx: number; dy: number };
    }
  | { type: "click"; t: number; button?: "primary" | "secondary" | "middle"; style?: Partial<CursorStyle> }
  | { type: "hide";  t: number };

interface CursorStyle {
  pointer: "mouse" | "touch";
  /** Inner ring + cursor stroke color. Default white with a thin black outline. */
  cursorFill: string;
  cursorStroke: string;
  /** Click pulse stroke color. Default white with a black hairline. */
  pulseStroke: string;
  pulseStrokeOuter: string;
  /** Click pulse duration in ms. Default 500. */
  pulseDurationMs: number;
  /** Click pulse max radius (outer edge) in px. Default 32. */
  pulseRadius: number;
  /** Cursor scale (1 = the 18-px-tall macOS arrow). Default 1. */
  cursorScale: number;
}

interface CursorOverlay {
  events: CursorEvent[];
  /** Defaults for every event; per-event `style` overrides these. */
  style?: Partial<CursorStyle>;
}
```

### `move` semantics

A `move` event positions the cursor at time `t`. One of three targeting modes:

- **`to`**: absolute viewport coordinates.
- **`by`**: relative offset from the cursor's previous position.
- **`selector`**: a CSS selector. The cursor moves to the **center** of the matched element's bounding rect (resolved at render time from the captured tree). When `offset` is also set, the move target is `(centerX + offset.dx, centerY + offset.dy)`.

`duration` (ms, default 0 = instant) interpolates the cursor linearly between the start and target positions. When 0, the cursor jumps; when > 0, the cursor slides.

### `click` semantics

Emits a click pulse at the current cursor position at time `t`. The button affects the pulse style:

- **primary** / **middle**: ring only.
- **secondary**: ring + right-half-fill of the inner circle.

`style` lets a single click override the global pulse defaults (e.g. a louder pulse for the demo's hero click).

### `show` / `hide`

`show` jumps the cursor to `(x, y)` and makes it visible. The cursor is hidden by default — overlays without a `show` event don't paint anything. `hide` removes the cursor at time `t`; subsequent events re-show it implicitly via `show` or `move(to: ...)`.

## Render

A new module `src/animation/cursor-overlay.ts`:

1. Resolves the script into low-level absolute keyframes:
   - `[ {t, x, y} ]` — cursor position over time, with linear interpolation between adjacent entries when both have the same segment.
   - `[ {t, x, y, button, style} ]` — click pulses.
2. Emits a `<g class="cursor-overlay" pointer-events="none">` appended to the top of the animated SVG (after the frame layers), containing:
   - The cursor arrow `<path>` with an `<animateTransform attributeName="transform" type="translate" values="..." keyTimes="..." dur="totalMs" fill="freeze">` that walks the position keyframes.
   - One `<circle>` per click, stamped at the click's `(x, y)` with `<animate attributeName="r" .../>` and `<animate attributeName="opacity" .../>` driving the pulse-out animation. The circle has `begin="<click t>ms"` so it activates at the right time.
   - For secondary clicks, an additional `<path>` (right half-disc) inside the ring.

The cursor arrow itself is a small SVG path approximating macOS's pointer:

```
M 0 0 L 0 16 L 4.5 12 L 7 18 L 9 17 L 6.5 11 L 12 11 Z
```

Stroke white-on-black so it's visible on either light or dark backgrounds.

## Selector resolution

`generateAnimatedSvg` already has access to the per-frame captured trees (`frames: CapturedElement[][]`). At render time, the cursor module receives a `resolveSelector(sel: string, frameIndex: number) => { x, y, w, h } | null` helper that walks the active frame's captured tree, runs `el.matches(sel)` on each, and returns the bounding rect of the first match. The frame index is derived from `t` (each frame's start/end time is known).

When the selector matches nothing in the active frame, the cursor stays at its previous position and a console warning is logged.

## Edge cases / out of scope

- **Pinch-zoom / rotation gestures**: not modeled.
- **Pen / stylus**: render as mouse.
- **Touch glyphs**: deferred — `pointer: "touch"` accepted but currently renders the same as mouse. A future ticket can add a finger-pad indicator.
- **Recording from real user sessions**: out of scope; the current API expects pre-authored event scripts.
- **Multi-pointer**: explicitly out of scope.

## Tests

- Unit: snapshot test for `cursorOverlayMarkup({events, style})` — given a fixed event timeline, the emitted SVG group is deterministic.
- Unit: selector resolution — given a tree with `<button class="ok">` at (50, 60, 80, 24), `move({selector: ".ok"})` resolves to `(90, 72)` (center).
- Visual: a 3-frame `examples/` demo with a click pulse mid-frame, verified through `demos:examples`.
