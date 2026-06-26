# 64 — Demo gallery

Status: **rebuilt.** The demo gallery now lives on the Astro + Starlight site
under `site/`, not the retired kerfjs manual. This doc is the requirements +
provenance reference for the progressive set of copy-pasteable examples that
sell what Domotion does, simplest to fanciest.

> **Site rebuild (DM-1308).** The original gallery was a kerfjs manual page
> (`site/pages/guides/demo-gallery.tsx`) backed by per-demo folders under
> `site/scripts/demos/<demo>/`. That whole legacy generator was removed when the
> site was rebuilt as Astro + Starlight. The gallery is now spread across the new
> site's **Showcase** and **Usage** pages (`site/src/content/docs/`), and the
> build copies the committed demo artifacts under `examples/` into the site at
> build time via `site/scripts/build-demos.mjs`.

## Where the demos live now

- **Capability + full-app demos** — `site/src/content/docs/showcase.mdx`, drawing
  on `examples/output/*.svg` (showcase-rendering, hero-product-demo, the four
  transition mini-demos + the chained transition-tour, terminal-onboarding,
  terminal-window-scroll, composite-config-demo), the template gallery
  (`examples/output/templates/*.svg`), and the real app captures
  (`site/demo-assets/apps/*.svg`).
- **Animated demos** — the runnable `domotion animate` configs under
  `examples/animate/<demo>/` (each with a committed golden SVG, registered in the
  `tests/animate-examples.tsx` regression suite) and the example scripts under
  `examples/` (e.g. `terminal-onboarding.ts`). These are surfaced and
  cross-linked from the site's Showcase / Usage pages.

The still-current animated demos and their headline capabilities:

| Tier | Demo | Headline capability |
|---|---|---|
| animated, simple | Tab switcher | `actions` click-through + crossfade |
| animated, simple | Typing search | a `typing` overlay |
| animated, simple | Before / after refactor | `push-left` transition across two files |
| animated, fancy | Terminal onboarding | a real `domotion term` cast (clone → install → configure → run) in window chrome |
| animated, fancy | Form fill flow | a real interaction recorded entirely via `actions` |
| animated, fancy | Scroll-through page | `--scroll` capture composed with a `scroll` transition |
| transitions | Transition tour | crossfade → push-left → scroll → crossfade chained in one SVG (DM-1414) |

## Tier 1 (single-capture) — retired

The original Tier-1 single-capture demos (hero card, pricing table, code block,
phone-framed screen) lived as `site/scripts/demos/<demo>/` folders and were
removed with the legacy site. On the new site they were superseded by richer
demos — the faithful-capture **showcase-rendering** and the product-dashboard
**hero-product-demo**. They have **not** been re-homed under `examples/`; if a
simple single-capture gallery is wanted again, re-create them as
`examples/<demo>/` with a `capture.sh` and a committed golden. The device-chrome
capability they exercised (`--chrome phone|browser|window`) is documented in
`docs/65-device-chrome.md`.

## Authoring conventions (animated demos)

- **One folder per demo** under `examples/animate/<demo>/`: a `domotion animate`
  config, the HTML frame(s) it captures, and a committed golden `<demo>.svg`.
- **Real HTML source files** (not inline strings) so the source is copyable and
  runnable.
- **A committed golden SVG** next to the config, browser-openable, verified by
  the `tests/animate-examples.tsx` byte-diff + structural regression suite.
- Each demo's viewport is sized to its content so there's no dead space.

See `examples/animate/README.md` for how the runnable examples are organized,
regenerated (`npm run demos:test:animate -- --update`), and verified.

---

## Tier 2 — animated, simple

Each is a `domotion animate` config + HTML frame(s) + committed golden under
`examples/animate/<demo>/`, registered in the `tests/animate-examples.tsx`
regression suite and surfaced on the site.

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
- **Output:** `before-after-refactor.svg` (720×400, 2 frames, push-left)
- **Demonstrates:** a `push-left` transition between two semantically-distinct
  code cards (a verbose loop → its `filter`/`reduce` refactor).
- **Both frames carry `push-left`.** A push-left transition is a coordinated
  pair: the outgoing frame slides off to the left *while* the incoming frame
  slides in from the right. (As of DM-1414 a frame's entrance is composed from
  the *previous* frame's transition, so mixed-type chains also compose — see the
  transition-tour demo — but a same-type pair like this is the simplest case.)
  `after` is the last frame and holds solid to the end via the last-frame hold
  (the slide-out is suppressed for the final frame unless `loopFade` is set).

## Tier 3 — animated, fancy

The marketing-video tier. Most are an `examples/animate/<demo>/` folder
registered in the regression suite and surfaced on the site; the
terminal-onboarding demo is instead a runnable example script
(`examples/terminal-onboarding.ts`) that drives the `domotion term` pipeline.

### Terminal onboarding

- **Source:** `examples/terminal-onboarding.ts` (a runnable example *script*, not
  an animate config — run with `npx tsx examples/terminal-onboarding.ts`)
- **Output:** `examples/output/terminal-onboarding.svg`
- **Demonstrates:** a real `domotion term` capture (doc 67). One continuous
  asciinema v2 cast — clone → install → configure → run — is replayed through the
  terminal pipeline (`castToAnimatedSvg`, the exact `domotion term --cast` path)
  and composited into window chrome via `composeAnimatedLayers`, mirroring
  `terminal-demo.ts`. The terminal types each command and streams its output
  natively/incrementally (real text as glyph paths, real ANSI color, native
  animation), so it reads as one genuine session.
- **Why a real cast, not faked panes.** The previous version faked four terminal
  panes with static HTML + `typing` overlays + delayed `clipPath` reveals, whose
  hand-tuned per-frame `delay` values drifted out of sync with the overlay typing
  speed — the typed command collided with the revealed output and the terminal
  showed dead/empty beats. A cast removes the timing hacks entirely: the VT
  emulator paces the typing and output reveal, so it can't desync (DM-1384).

### Form fill flow

- **Source:** `examples/animate/form-fill/` (`signup.html`, `form-fill.json`)
- **Output:** `form-fill.svg` (560×480, 4 frames)
- **Demonstrates:** a signup form filled out with **simulated typing**. Each
  frame `continue`s the live page, `focus`es the next field, and a `typing`
  overlay (with a caret) types into it; the *following* frame `fill`s that field
  for real so its value persists while the next field types. The last frame
  clicks submit and a small `wait` lets the success banner render.
- **Why a typing overlay + `fill` handoff?** `fill` alone sets a value
  instantly — no per-character typing or cursor. The overlay supplies the
  animated typing + caret; the real `fill` on the next frame makes the value
  stick (an overlay only paints during its own frame). The form inputs are set
  to **monospace** to match the overlay's font so the typed text and the
  `fill`ed value line up seamlessly across the cut. The password field types
  bullet glyphs and `fill`s a real value the browser masks — the dot counts
  match.

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
