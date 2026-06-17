# 64 — Demo gallery

Status: **in progress.** Tier 1 (single-capture) demos are shipped; Tier 2/3
(animated) are landing incrementally.

This doc is the requirements + provenance reference for the **demo gallery** —
the progressive set of copy-pasteable examples that sells what Domotion does,
simplest to fanciest. Each demo is a self-contained folder under
`site/scripts/demos/<demo>/` holding its HTML source, the exact command (or
build script) that produces the output, and the committed golden SVG, so a
reader can open the SVG in a browser and copy the source without running
anything. The manual surfaces them on the **Guides → Demo gallery** page
(`site/pages/guides/demo-gallery.tsx`).

The animated (Tier 2/3) demos reuse the runnable `domotion animate` configs
under `examples/animate/` where one already covers the pattern (see the table
below) rather than duplicating them; the gallery page links those.

## Why a gallery

The brainstorm behind this (the parent "killer demos" effort) wanted the
manual to have a progressive examples gallery — an "oh, I get it" Tier 1, an
animated-but-simple Tier 2, and a marketing-video Tier 3 — all expressed in
short enough code to copy. Each demo demonstrates one headline capability:

| Tier | Demo | Headline capability |
|---|---|---|
| 1 — single capture | Hero card | gradient + shadow + monospace fidelity in one `capture` |
| 1 — single capture | Pricing table | multi-column marketing layout, crisp at any scale |
| 1 — single capture | Code block | syntax-highlighted `<pre>` — text stays selectable in the SVG |
| 1 — single capture | Phone-framed screen | a mobile capture wrapped in device chrome |
| 2 — animated, simple | Tab switcher | `actions` click-through + crossfade |
| 2 — animated, simple | Typing search | a `typing` overlay |
| 2 — animated, simple | Before / after refactor | `push-left` transition across two files |
| 3 — animated, fancy | Terminal onboarding | multi-step push-left + typing overlays + terminal chrome |
| 3 — animated, fancy | Form fill flow | a real interaction recorded entirely via `actions` |
| 3 — animated, fancy | Scroll-through page | `--scroll` capture composed with a `scroll` transition |

## Authoring conventions

- **One folder per demo** under `site/scripts/demos/<demo>/`.
- **Real HTML source files** (not inline strings) so the manual can show
  copyable, runnable source. Tier 1 demos are plain `*.html`; animated demos
  reuse the `examples/animate/<demo>/` config + frame files.
- **A `capture.sh`** (Tier 1) holding the exact published-CLI command, or a
  **`build-*.ts`** script where a plain `capture` can't express the demo.
- **A committed golden SVG** next to the source, browser-openable.
- Dark theme (`#0d1117` background, `#e6edf3` text) to match the rest of the
  manual's imagery. Each demo's viewport is sized to its content (probe
  `document.body.scrollHeight` and trim) so there's no dead space.

## Regenerating

Tier 1 demos regenerate from their folder with the published CLI form in
`capture.sh` (from a checkout, swap `domotion` for `npx tsx src/cli/index.ts`):

```sh
cd site/scripts/demos/hero-card && bash capture.sh
```

---

## Tier 1 — single capture

### Hero card

- **Source:** `site/scripts/demos/hero-card/hero-card.html`
- **Command:** `site/scripts/demos/hero-card/capture.sh` — `domotion capture
  hero-card.html --width 720 --height 280 --optimize -o hero-card.svg`
- **Output:** `hero-card.svg` (720×280)
- **Demonstrates:** a gradient-filled logo tile with a drop shadow, a tight
  letter-spaced headline, and a monospace command chip — all the everyday
  "marketing card" ingredients in a single static capture. Mirrors the
  long-standing `site/assets/img/hero-card.svg` imagery, but now with the
  copyable HTML beside it (which is what the gallery was missing).

### Pricing table

- **Source:** `site/scripts/demos/pricing-table/pricing-table.html`
- **Command:** `capture.sh` — `--width 960 --height 410 --optimize`
- **Output:** `pricing-table.svg` (960×410)
- **Demonstrates:** a polished three-tier (Free / Pro / Enterprise) table with
  a highlighted middle column, a gradient "Popular" badge, gradient CTA, and
  check/cross feature rows. The kind of static marketing visual people pay a
  monthly design-tool subscription to produce — captured crisp and scalable.

### Code block

- **Source:** `site/scripts/demos/code-block/code-block.html`
- **Command:** `capture.sh` — `--width 720 --height 360 --optimize`
- **Output:** `code-block.svg` (720×360)
- **Demonstrates:** a real `<pre><code>` with hand-rolled `<span>`-colored
  syntax tokens inside a window-chrome card. The headline point: the captured
  text is emitted as glyph paths, so it stays sharp at any zoom — and the
  document structure is inspectable in the SVG rather than a flattened raster.

### Phone-framed mobile screen

- **Source:** `site/scripts/demos/phone-screen/mobile-screen.html`
- **Build:** `capture.sh` → capture at `--width 390 --height 844 --mobile`,
  then `build-phone-screen.ts` wraps the capture in a phone bezel.
- **Output:** `mobile-screen.svg` (390×844, the bare capture) +
  `phone-screen.svg` (418×872, bezel-wrapped)
- **Demonstrates:** a mobile-viewport capture presented inside device chrome
  (rounded body, dynamic-island notch, home indicator). The bezel-wrapped form
  is the marketing asset; the bare capture is the raw single-frame output.
- **Caveat — no `--chrome` flag yet.** Device chrome is not a CLI feature
  today, so the bezel is hand-drawn in `build-phone-screen.ts` (the same
  approach `site/scripts/build-install-demo.ts` uses for its inline phone
  preview). It nests the *committed capture SVG* inside the bezel rather than
  re-rendering the element tree, so the glyph paths match the standalone
  capture exactly (re-rendering through a second path-render dropped the system
  font and fell back to `.notdef` tofu). When a `--chrome <device>` flag lands,
  the whole demo collapses to one `domotion capture … --chrome phone` line and
  the build script can be retired. That flag is tracked as a follow-up feature.

---

## Tier 2 — animated, simple

Each is a `domotion animate` config + HTML frame(s) + committed golden under
`examples/animate/<demo>/`, registered in the `tests/animate-examples.tsx`
regression suite and embedded on the gallery page.

### Typing search

- **Source:** `examples/animate/typing-search/` (`search-bar.html` + `typing-search.json`)
- **Output:** `typing-search.svg` (720×260, 1 frame)
- **Demonstrates:** a single captured frame with a `typing` overlay that reveals
  "how to install" character-by-character (with a caret) into a docs-style
  search field. The overlay `x`/`y` are anchored over the input's empty text
  slot (probed via `getBoundingClientRect`).

### Tab switcher

- **Source:** `examples/animate/tab-switcher/` (`tabs.html` + `tab-switcher.json`)
- **Output:** `tab-switcher.svg` (640×320, 3 frames, crossfade)
- **Demonstrates:** click-action-driven capture. Each frame `continue`s the live
  page and fires `{ type: "click", selector: ".tab-2" }` / `".tab-3"`; the
  page's own click handler switches the active tab/panel, and the resulting
  states crossfade. Proves a real interaction can drive each frame.

### Before / after refactor

- **Source:** `examples/animate/before-after-refactor/` (`before.html`,
  `after.html`, `before-after-refactor.json`)
- **Output:** `before-after-refactor.svg` (720×400, 3 frames, push-left)
- **Demonstrates:** a `push-left` transition between two semantically-distinct
  code cards (a verbose loop → its `filter`/`reduce` refactor).
- **Why three frames for two files?** A push-left frame that is *last* in the
  loop currently fades out across its hold (the DM-1148 "hold last frame solid"
  fix is wired into the crossfade/cut emit path but not the push-left path), so
  a naive 2-frame `before → after` dissolves the "after" punchline. The config
  works around it by repeating `after.html` with a trailing `cut` frame, so
  "after" is a held middle frame followed by an identical held last frame. When
  the push-left hold-to-end gap is fixed, collapse this back to two frames.

## Tier 3 — animated, fancy

The marketing-video tier. Like Tier 2, each is an `examples/animate/<demo>/`
folder registered in the regression suite and embedded on the gallery page.

### Multi-step terminal onboarding

- **Source:** `examples/animate/terminal-onboarding/` (`step-1-clone.html` …
  `step-4-run.html`, `step-4-run-final.html`, `terminal-onboarding.json`)
- **Output:** `terminal-onboarding.svg` (720×360, 5 frames)
- **Demonstrates:** four terminal panes (clone → install → configure → run),
  each with terminal chrome, a `typing` overlay that types that step's command
  (all four overlays share one `x`/`y` anchor over the prompt slot), and a
  `push-left` transition between steps.
- **5 frames for 4 steps:** the trailing `step-4-run-final.html` (cut, command
  baked in statically) holds the final step solid — the push-left last-frame
  fade workaround again. The typed command on step 4 is an *overlay*, so the
  held duplicate carries the command as static text instead.

### Form fill flow

- **Source:** `examples/animate/form-fill/` (`signup.html`, `form-fill.json`)
- **Output:** `form-fill.svg` (560×480, 5 frames)
- **Demonstrates:** a signup form driven entirely by `actions` — each frame
  `continue`s the live page and runs `click` + `fill` on the next field, then a
  final frame clicks submit and a small `wait` lets the success message render.
  The `type=password` field masks its value; the success reveal proves a real
  interaction outcome is captured.

### Scroll-through a long page

- **Source:** `examples/animate/scroll-landing/` (`landing.html`,
  `scroll-landing.json`)
- **Output:** `scroll-landing.svg` (480×640, 1 frame)
- **Demonstrates:** one tall landing page (hero → features → testimonial → CTA
  → footer) captured at successive scroll positions via a `scroll` block
  (`down:bottom/5s`) and composed into a single scrolling SVG. The sticky nav
  stays pinned while the sections scroll past.
- **Note:** the nav is intentionally opaque (no `backdrop-filter`) — a
  translucent sticky header lets scrolled content show through in the SVG,
  since the frosted-backdrop blur isn't reproduced (see `docs/19-frosted-
  backdrop-fallback.md`). A complementary social-feed scroll lives in
  `examples/animate/scroll-feed/`.

See `docs/08-animation-model.md` and `docs/43-declarative-animate-config.md`
for the animate config surface, and `examples/animate/README.md` for how the
runnable examples are organized and verified.
