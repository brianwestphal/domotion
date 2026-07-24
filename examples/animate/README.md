# `domotion animate` examples

Runnable example configs for the `domotion animate` command. Each folder holds a
self-contained `<name>.json` config, the HTML frame(s) it captures, and a
committed golden `<name>.svg` — the actual, browser-openable output, so you can
see what each config produces without running anything.

Open any `<name>.svg` in a browser to watch it loop.

## The examples

| Folder | Demonstrates |
|---|---|
| `crossfade-cards/` | A **crossfade** transition between two full-bleed scenes. Each frame composites as a complete sub-SVG and dissolves by opacity. |
| `progress-install/` | **`cut`** transitions between terminal states, a **typing overlay** (with a blinking `caret`) that types a command, and an **intra-frame `animations`** entry that fills a progress bar by revealing a full-width fill via a **`clipPath` inset**. |
| `slides-pushleft/` | A **`push-left`** transition across three slides — each slides in from the right while the previous slides off to the left. |
| `scroll-feed/` | A **`scroll` block**: one tall page captured at multiple scroll positions via the pattern grammar (`down:bottom/6s`) and composed into one scrolling SVG. The sticky header stays put while the feed scrolls. |
| `svg-overlay/` | A **`kind: "svg"` overlay** — a separately-authored `badge.svg` inlined into the frame (its ids namespaced to avoid collisions) and slid in from the bottom with the `enter` sugar. |
| `typing-search/` | A single frame with a **`typing` overlay** revealing a query into a docs-style search bar; the overlay is anchored over the input's empty text slot. (Gallery demo — see `docs/64-demo-gallery.md`.) |
| `tab-switcher/` | Three **`continue` frames driven by `click` actions** (`.tab-2`, `.tab-3`) on a live page, composited with **crossfade** — a real interaction recorded frame by frame. |
| `before-after-refactor/` | A **`push-left`** transition between two code cards (before → after). Both frames carry `push-left` (it's a coordinated slide pair); `after` is last and holds solid. |
| `form-fill/` | A signup form filled with **simulated typing**: each field is `focus`ed and typed by a caret **`typing` overlay**, then `fill`ed for real so it persists while the next field types; submit reveals a success banner. Inputs are monospace to match the overlay font. (Gallery Tier 3.) |
| `type-resample/` | A phone field typed with **`typeResample`** — per-keystroke real-site re-sampling (docs/93 §2). Each raw digit is typed for real and the page re-captured, so the field's OWN input mask (`4155550142` → `(415) 555-0142`) and its green `.valid` border are what render, not the raw keystrokes. The N states nest as one frame's animated SVG. |
| `scroll-landing/` | A tall landing page (hero → features → testimonial → CTA) scrolled top→bottom via a **`scroll` block** (`down:bottom/5s`); the sticky nav stays pinned. (Gallery Tier 3.) |
| `cursor-auto/` | A config-level **`cursor: "auto"`** overlay: the pointer auto-glides to each `click`/`hover`/`fill` target and pulses on click. Here it glides to the "Deploy now" button on a continued page and clicks it. |
| `cursor-events/` | A config-level **`cursor: { events: [...] }`** overlay: an explicit timeline of pointer moves. A `move` to fixed coords, then a `moveClick` whose `selector` resolves to the button's center — with a `style.scale` tweak. |
| `hover-state/` | A per-frame **`forceState`** entry that forces `.cta` into `:hover` via CDP before capture, so frame 1 paints the page's OWN hover styling (brighter button + box-shadow ring) — and the `.card:has(.cta:hover)` sibling rule fires too, highlighting the card border. Paired with a `cursor` move so the pointer sits on the button. Cross-fades from the rest state. See `docs/94-interaction-state-capture.md`. |
| `brand-mixed/` | A config-level **`brand`** key (no CLI flag) themes BOTH a **`template` frame** (a `lower-third` banner — brand accent bar + logo mark, via the template's brand defaults) AND a **captured page** (the orange eyebrow + purple CTA, via CSS-variable injection). One brand, set once on the config. See `docs/85-brand-kit.md` + `docs/92-brand-for-capture.md`. |
| `hover-reveal/` | The one-field **`hoverReveal: { selector }`** sugar — auto-expands into the same rest → forced-`:hover` crossfade pair as `hover-state`, plus a cursor move onto the button, from a single line instead of two hand-wired frames. See `docs/94-interaction-state-capture.md`. |
| `hover-detect/` | **`hoverDetect: { selector }`** auto-detection: a pre-pass drives a real `:hover`, diffs `getComputedStyle`, finds ONLY a transform change (a pure scale), and synthesizes a single-frame intra-frame keyframe **tween** (scale 1 → 1.08) rather than a crossfade — no manual `forceState`. See `docs/94-interaction-state-capture.md`. |
| `js-reveal/` | A per-frame **`jsReveal`** entry (docs/94 option 3): dispatches `mouseover` on an "Account" button whose JS **injects a dropdown menu** and flips `aria-expanded`, runs a MutationObserver until the DOM settles, and cross-fades rest→after. Catches JS-driven feedback `forceState` (CSS pseudo-state forcing) cannot. |
| `compressed-run/` | A **`states` compressed run** (docs/100 Primitive 1, docs/43 §11): seven captured editing states of a mid-line insert + a colorize composed by the frame-sequence compressor into one nested animated SVG, with the **auto-caret** riding the derived edit points — then a **`textTracks`** frame (docs/43 §12) parking a declarative caret and sweeping a selection. |
| `region-timing/` | **Independent per-region timing** in one compressed run (docs/100, docs/43 §11.1): two panes declared as **`regions`** (an editor left, a scrolling preview right) with each state tagged by the region it **`advances`** — so the two sequences are authored independently instead of hand-interleaved, and the seven states cost **four** whole-page captures instead of seven. |
| `editor-session/` | **The flagship editing rebuild** (docs/100 stage 5): the kerf getting-started EDITOR phases on the new primitives — five lines typed via **`holdToFrameEnd` + `anchor.baseline`** overlays handing off to real page text at cuts (no cover rects, no reveal choreography, no hand-tuned ascent constants), the ` computed,` insert and the `"btn"` → `{cls}` replacement as per-keystroke **`states` runs** with auto-carets and in-place recolor states, and the selection as a declarative **`textTracks`** sweep. The page uses the reusable editing-page rig from `docs/102-editing-page-rig-cookbook.md`. |

The config format is documented in `docs/08-animation-model.md`,
`docs/43-declarative-animate-config.md`, and the CLI `--help`. Paths inside a
config (`input`, overlay `src`) resolve relative to the config file's own
directory.

Each config opens with a `"$schema"` pointer to the published
[JSON Schema](../../schemas/animate-config.schema.json)
(`schemas/animate-config.schema.json`, also at a stable
`raw.githubusercontent.com` URL), so a JSON-Schema-aware editor gives you
autocompletion and structural validation as you write. The CLI ignores the key.

## Running

With the published package:

```bash
npx domotion animate examples/animate/crossfade-cards/crossfade-cards.json
```

From a checkout (no build step needed):

```bash
npx tsx src/cli/index.ts animate examples/animate/crossfade-cards/crossfade-cards.json
```

Either writes `crossfade-cards.svg` next to the config.

## Regenerating and verifying the goldens

These examples double as a regression suite (`tests/animate-examples.tsx`):

```bash
npm run demos:test:animate            # verify every example against its golden
npm run demos:test:animate -- --only slides-pushleft
npm run demos:test:animate -- --update   # rewrite goldens from current output
```

Two layers of checking:

- **Byte-diff against the golden** — runs on the platform that produced the
  golden (macOS today). Before comparing, the harness normalizes the two
  per-run-nondeterministic bits (the embedded-font base64 payload and the scroll
  composer's random id namespace); everything else is byte-stable.
- **Structural assertions** — run on every platform. The text→glyph-path
  renderer is calibrated to the host's system fonts, so on Linux the same config
  emits `<text>` instead of glyph paths and can't byte-match a macOS golden;
  there the harness checks output shape only (frame groups, transition
  keyframes, overlay markup, scroll composite, viewBox).

If you intentionally change an example or the renderer, rerun with `--update`
and commit the new `<name>.svg`.

## Authoring note: gradient backgrounds

These scenes happen to put gradient backgrounds on a full-size wrapper `<div>`.
A gradient applied directly to `<body>` also captures correctly now — either
pattern works.
