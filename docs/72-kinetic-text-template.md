# 72 — `kinetic-text` template

Status: **shipped** (DM-1277). A built-in **generator** template (doc 70
contract) for kinetic typography — reveal a headline word-by-word or
character-by-character.

## What it is

`domotion template kinetic-text` takes a headline string and expands it at author
time into per-word (or per-character) units, each revealed with its own staggered
one-shot animation, then held assembled. It's the **clearest demonstration of the
template thesis** (doc 70): the "split text → synthesize N staggered keyframes"
work is pure pre-processing that runs once; the emitted SVG just replays it.

```sh
# Word-by-word rise (default).
domotion template kinetic-text --text "Ship faster with Domotion" -o title.svg

# Character-by-character slide-in, big.
domotion template kinetic-text --text "MOTION" --variant slide --by char \
  --fontSize 140 -o motion.svg

# Multi-line (\n) + inline emphasis + a continuous boomerang loop.
domotion template kinetic-text \
  --text 'Build <font color="#22d3ee">motion</font>\nright in the <i>browser</i>' \
  --loop boomerang -o build.svg
```

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `text` | string (1–400) | — | The headline (**required**). `\n` → line break; a light set of inline tags styles words (see *Multi-line & emphasis*). |
| `variant` | `rise` \| `slide` \| `fade` \| `clip` | `rise` | Reveal style: rise up, slide in from the left, fade, or `clip` (a left-to-right wipe). |
| `loop` | `loop` \| `boomerang` | `loop` | `loop` replays the reveal each scene cycle; `boomerang` makes each unit assemble + disassemble continuously. |
| `by` | `word` \| `char` | `word` | Animate per word or per character. |
| `width` / `height` | int | `1280` / `720` | Output size in px. |
| `fontSize` | int | `88` | Font size in px. |
| `fontWeight` | int | `800` | Font weight. |
| `color` | string | `#f5f7fa` | Text color. |
| `background` | string | `#0b1020` | Frame background (or `transparent`). |
| `align` | `center` \| `left` | `center` | Text alignment. |
| `fontFamily` | string | system sans | CSS font-family stack. |
| `staggerMs` | int | `90` | Delay between units. |
| `revealMs` | int | `600` | Per-unit reveal duration. |
| `holdMs` | int | `1600` | Hold after the full reveal. |

On-screen time (`loop`) = `(units − 1) × staggerMs + revealMs + holdMs`; for
`boomerang` it's `(units − 1) × staggerMs + 2 × revealMs` (one assemble +
disassemble — the per-unit animations then repeat infinitely).

## Multi-line & emphasis (DM-1286)

`text` may contain `\n` (a literal backslash-n in a flag value, or an actual
newline in JSON params) for **line breaks** — each line is a block; units keep one
global stagger sequence across the whole headline.

A light, safelisted set of **inline emphasis tags** styles individual words:

| Tag(s) | Effect |
|---|---|
| `<b>`, `<strong>` | bold (`font-weight:900`) |
| `<i>`, `<em>` | italic |
| `<u>`, `<ins>` | underline |
| `<s>`, `<del>`, `<strike>` | line-through |
| `<font color="…">` | text color |

Tags nest, and a word with mixed styling is split into per-style segments inside
its animated unit (so the reveal still applies to the whole word/char). **Anything
outside the safelist is dropped** — no other tag, attribute, or `style` reaches the
output, and a `<font color>` value is stripped to CSS-color-safe characters, so the
markup can never inject arbitrary CSS/markup. A stray `<` / `&` is escaped as
literal text.

## Loop modes (DM-1286)

The composed SVG always loops. `loop` (default) replays the staggered reveal each
cycle — a hard cut at the loop seam, the classic "re-type" look. `boomerang` sets
every reveal animation to `repeat: infinite` with `alternate`, so each unit
assembles then disassembles forever (phase-offset by its stagger) — a continuous
shimmer with no seam. (A coordinated assemble → *hold* → disassemble cycle would
need multi-stop intra-frame keyframes, which the `animations` API doesn't yet
express — a possible future enhancement.)

## How it works

`parseStyledText` walks the headline into lines of styled characters (handling
`\n` and the emphasis safelist); `planUnits` then splits each line on whitespace
into words (empty tokens dropped), and in `char` mode each word's characters become
units while the word stays a `white-space: nowrap` group so it never breaks
mid-word. In `loop` mode each unit's reveal is **one-shot** (no `repeat`): the
animator holds the `from` state until the unit's staggered turn, animates it in,
then holds `to`, so the headline assembles and stays put (the scene then replays).

The motion respects the same two constraints as `background-loop` (doc 71):

1. **One animation per captured element**, so each unit is a `.kt-w-<n>`
   transform-wrapper around a `.kt-wi-<n>` opacity-inner — two distinct
   selectors, two animations that don't override each other.
2. **SVG transforms are origin-(0,0)**, so the move is an origin-safe
   `translateY` (rise) or `translateX` (slide) in `em` units; `fade` uses opacity
   only (one animation per unit). `clip` (DM-1286) wipes the wrapper left-to-right
   via the `clipPath` intra-frame property — `inset(-10% 100% -10% 0)` →
   `inset(-10% 0% -10% 0)` (the right inset animates 100% → 0%; the ±10%
   top/bottom keeps ascenders/descenders from being clipped during the wipe).

All generation is pure and unit-tested without a browser: `planUnits` (split +
index), `buildKineticHtml`, `buildKineticAnimations`, `kineticDurationMs`.

## Code

- **`src/templates/builtin/kinetic-text.ts`** — the pure generators above plus
  the `kineticTextTemplate`. Registered in `src/templates/registry.ts`;
  re-exported from the package root.

## Follow-ups

DM-1286 shipped the `clip` wipe variant, multi-line `\n`, inline emphasis tags,
and the `loop` / `boomerang` modes. Two reveal variants remain blocked on
rendering-pipeline capabilities (filed separately):

- **`blur-in`** (DM-1296) — needs `filter: blur()` capture fidelity, which the SVG
  pipeline doesn't yet reproduce; the `clip` wipe is the soft-reveal substitute.
- **`scale-pop`** (DM-1297) — needs a *center* `transform-origin`; SVG transforms
  are origin-(0,0), so a scale shifts the unit instead of popping in place.
