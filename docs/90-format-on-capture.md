# 90 — `--format` on `capture` / `animate` (viewport sizing)

**Status: shipped (DM-1538).** `domotion capture` and `domotion animate` accept
the same `--format <name|WxH>` flag `domotion template` already had (docs/87),
extending the SAME `resolveFormat` + precedence machinery — no fork. On these two
verbs a format sizes the **capture viewport** (the pixels Chromium paints into),
not a template canvas.

See also: [docs/87 — format presets](./87-format-presets.md) (the `FORMATS`
table, presets, safe-area insets) and
[docs/91 — adaptive format scaling](./91-adaptive-format-scaling.md) (how
themeable templates scale type per ratio).

## `capture`

```sh
domotion capture page.html --format reel        -o reel.svg        # 1080×1920 viewport
domotion capture page.html --format landscape   -o hero.svg        # 1920×1080 viewport
domotion capture page.html --format 1600x900    -o custom.svg      # raw WxH
```

`--format` sets the viewport `width`/`height`. Precedence is unchanged from the
template verb:

```
explicit --width / --height  >  --format preset  >  default 800×600
```

An explicit flag can pin one axis while the format supplies the other
(`--format reel --width 800` → 800×1920). `--format` accepts a preset **name /
alias** (`reel`, `story`, `square`, `portrait`, `landscape`) or a raw
`WIDTHxHEIGHT`, validated by the shared `resolveFormat` (a bad value fails at the
CLI boundary with the valid presets listed).

### Device frame (`--chrome`) interaction

When a device mockup is involved (`--chrome phone|browser|window`), **the format
sizes the captured _content_ (the inner screen); the bezel is added _around_
it.** So `--format reel --chrome phone` captures the page into a 1080×1920 screen
and nests it in the phone body. This is the natural reading of "a reel, on a
phone": the reel _is_ the screen. The final output dimensions therefore exceed
the format size by the bezel; the CLI's `Wrapped in … chrome (W×H)` log line
reports the framed total.

(The alternative — format sizes the whole output, so the screen is
`format − bezel` — was rejected: bezel sizes vary per device, and a creator
picking `reel` wants a reel-sized _screen_, not a reel-sized outer rectangle they
must mentally subtract the frame from.)

**Scaled phone bezel (DM-1559).** The phone bezel's rim / corner radius / notch /
home indicator are tuned for a ~390-px-wide phone. Left fixed, a 1080-wide reel
screen would get a 14 px rim — a hairline that reads as a bordered rectangle, not
a phone. So the phone bezel geometry **scales with the screen** by
`s = max(1, min(screenW, screenH) / 390)`: a reel screen gets a proportionate
~39 px rim and ~155 px corner radius, so `--format reel --chrome phone` yields a
**1158×1998** output that still reads as a phone. The `max(1, …)` floor keeps a
phone at or below the reference size on the calibrated bezel — a ≤390-wide
capture is byte-for-byte identical to the pre-scaling output. `browser` / `window`
bezels (a fixed-height top bar only) are unchanged; scaling their bar / traffic
lights per width is a possible follow-up. The same scaling applies through the
`device-mockup` template — `domotion template device-mockup --device phone
--format reel` sizes the screen to 1080×1920 and wraps it in the scaled phone
body.

### Safe area on a raw capture (`--safe-guide`)

A format also carries a **safe-area inset** (docs/87). A _template_ reflows its
content within `canvas − safeInset`; a **raw capture has no template layout to
reflow** — it captures whatever the page painted. So on `capture` the safe inset
is **informational**, not a reflow:

- **`--safe-guide`** overlays a non-destructive dashed rectangle (plus corner
  ticks) at the resolved safe area, in the capture's own coordinate space (drawn
  _before_ any bezel wrap, so it sits over the content). It shows whether the
  captured content clears the platform's caption bar / action rail. It requires
  `--format` (no format → no safe area to draw) and reflows nothing.
- **`--debug`** additionally writes `safe-area.json` into the debug bundle
  (`{ format, width, height, safeInset }`) so the numbers are recorded alongside
  the other reproduction artifacts (docs/55).

```sh
domotion capture page.html --format reel --safe-guide -o reel.svg
domotion capture page.html --format reel --debug -o reel.svg   # → reel.debug/safe-area.json
```

The guide is emitted by the shared `safeAreaGuideSvg(width, height, safeInset)`
helper (`src/templates/formats.ts`) — pure SVG primitives, no font dependency, so
it renders identically cross-viewer.

## `animate`

```sh
domotion animate demo.json --format reel                  # re-target the config canvas to 1080×1920
domotion animate demo.json --format reel --width 720      # explicit axis still wins
```

`--format` (plus `--width` / `--height`) re-targets the config's canvas — the
animate viewport every frame is captured at. Precedence:

```
explicit --width / --height  >  --format preset  >  the config's own width / height
```

(The config's `width`/`height` act as the default here.) The format's safe-area
inset **rides through to any `template` frame** (docs/73) so a themeable built-in
in an animate composition honors the format's safe margins + adaptive type
scaling (docs/91), exactly as a standalone `domotion template --format …` render
would. Page / captured frames don't reflow to the inset — the format only sizes
their viewport.

## Implementation

- `src/cli/capture.ts` — resolves `--format` into the viewport width/height
  (`parseIntFlag` default becomes the format's size), validates `--safe-guide`
  requires `--format`, injects `safeAreaGuideSvg(...)` before the chrome wrap, and
  writes `safe-area.json` under `--debug`.
- `src/cli/animate.ts` — `runAnimate` applies `--format`/`--width`/`--height`
  onto `cfg.width`/`cfg.height` and threads the safe inset through
  `composeAnimateConfig` → `composeAnimateFrames` → `renderTemplateFrames` into
  each template frame's render context (`ComposeAnimateOptions.safeInset`).
- Both reuse `resolveFormat` / `FORMATS` / `safeAreaGuideSvg` from
  `src/templates/formats.ts` — one source of truth shared with `template`.

## Follow-ups

- A `--safe-guide` for `animate` output (currently a capture-only debug aid).
- Optionally surface the safe rectangle in `svg-review` (docs/54) so a reviewer
  can toggle it over any capture.
