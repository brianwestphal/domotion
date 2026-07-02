# 86 — Creative template pack

**Status: design (DM-1523).** Implementation split into follow-up tickets (see
end). A DM-1519 follow-up: the current templates lean product/marketing-UI
(chart, chat, subscribe, lower-third, device-mockup, kinetic-text,
background-loop). Storytellers and marketers want **narrative building blocks**.

Every template here is an ordinary `Template` (doc 70) — a `render(params)` that
synthesizes HTML/CSS + an `animate` config and runs it through
`runSingleFrameGenerator`, using the existing intra-frame animations plus the
`fuse` primitive (docs/08, DM-1512/1513/1517). No new rendering code; they
inherit every fidelity fix, `prefers-reduced-motion`, and cross-engine safety.
They compose with the **brand kit** (DM-1522 — each gets a `brandDefaults`) and
**format presets** (DM-1521).

## The templates

### 1. `title-card` (intro)
A full-bleed opening card: an optional eyebrow/kicker, a large headline, an
optional subtitle, on a brand background. Staggered fade-up/`pop` reveal (reuse
the kinetic-text motion vocabulary), then hold.
Params: `title` (req), `subtitle`, `eyebrow`, `align` (left/center), `background`,
`textColor`, `accent`, `fontFamily`, `width`, `height`, `holdMs`.

### 2. `quote` (testimonial)
A pull-quote block + attribution (name, role/handle, optional avatar
initial/color). Quote fades/slides in; a large decorative quotation mark and an
accent rule animate in. Params: `quote` (req), `author`, `role`, `avatarColor`,
`avatarInitial`, `accent`, theme, sizing.

### 3. `caption` (subtitle strip)
A single caption line for **pairing over other content** — transparent
background, anchored bottom-center within safe margins, with an explicit in/out
(fade or slide). Distinct from `lower-third` (a titled panel with accent bar):
`caption` is a lightweight subtitle for compositing over a captured demo/video.
Params: `text` (req), `position`, `maxWidthPct`, `bgOpacity`, `in`/`out` preset,
`holdMs`, sizing.

### 4. `counter` (countdown / number-ticker)
Animate a number `from → to` (count-up, count-down, or a timer), with prefix/
suffix and grouping. **Technique — odometer digit reels (CSS-transform, no
per-frame text):** render each digit column as a vertical strip `0..9` (or the
needed range) inside a clipped box and `translateY` the strip so the target digit
lands in the window. That's a pure `transform` animation — cross-engine-safe,
scalable, and fuse-friendly — instead of many discrete text frames. Per-digit
stagger + easing gives the satisfying "roll." Params: `from`, `to`, `duration`,
`prefix`, `suffix`, `grouping` (thousands sep), `decimals`, `easing`.

### 5. `stat` (big-stat / KPI callout)
A large headline value + label + optional delta/trend chip (`▲ 8.1%`). The value
reuses the `counter` odometer; the delta chip fades in after. Params: `value`,
`label`, `delta`, `deltaDir` (up/down), `accent`, `animateValue` (bool → odometer
from 0), sizing. (Shares the digit-reel module with `counter`.)

### 6. `compare` (before / after)
Two visuals (image, captured page, or an existing SVG) with the "after" revealed
over the "before" via a **clip-path wipe or slider** (linear/vertical), plus
optional before/after labels. The wipe is the same clip-path animation family as
DM-1524; this template is a packaged front-end for the common comparison case.
Params: `before` (req), `after` (req), `mode` (wipe/slide), `direction`, `labels`,
sizing. (Static inputs nest as images/SVG; a captured page uses `captureToSvg`.)

### 7. `cta` (end-card)
A closing card: headline + a call-to-action button + optional logo + social
handles/URL. Elements stagger in; the button can pulse (repeat animation).
Params: `headline`, `cta` (label), `ctaColor`, `logo`, `handles` (array), `url`,
`background`, sizing.

## Cross-cutting design notes

- **Shared digit-reel module.** `counter` and `stat` share one internal helper
  that lays out odometer columns + emits the per-column `translateY` keyframes.
  Build it once (in the `counter` ticket) and reuse.
- **Motion vocabulary.** These lean on the same reveals kinetic-text/lower-third
  use; when the **motion preset library** (DM-1526) lands, they should consume
  named presets rather than re-declaring cubic-beziers.
- **Brand + format.** Each template's `brandDefaults` (DM-1522) + honoring the
  format preset's canvas/safe-margins (DM-1521). Text cards especially must
  reflow sensibly at 9:16.
- **Reduced motion.** Inherited from the animate pipeline — reveals degrade to a
  cut; the odometer pins to its final value.

## Follow-up tickets (implementation, grouped)

Grouped by shared technique rather than one-per-template (7 would fragment the
shared code):

- **Batch A — text cards:** `title-card`, `quote`, `caption`, `cta`. All are
  HTML + a staggered reveal; share layout/reveal scaffolding.
- **Batch B — number animation:** `counter` + `stat`, built on a shared
  odometer digit-reel module (the one genuinely new technique in the pack).
- **Batch C — comparison:** `compare` (clip-path wipe/slider); coordinate with
  DM-1524 so the wipe is the same effect implementation.

Each batch: the template(s) + params schema + `brandDefaults` + unit tests
(pure param/layout logic) + a demo added to `examples/templates-demo.ts` + a
`FEATURES.md`/registry entry.
