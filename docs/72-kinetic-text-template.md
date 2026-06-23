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
```

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `text` | string (1–200) | — | The headline to animate (**required**). |
| `variant` | `rise` \| `slide` \| `fade` | `rise` | Reveal style: rise up, slide in from the left, or fade. |
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

Total on-screen time = `(units − 1) × staggerMs + revealMs + holdMs`.

## How it works

The headline is split on whitespace into words (empty tokens dropped); in `char`
mode each word's characters become units while the word stays a `white-space:
nowrap` group so it never breaks mid-word. Each unit's reveal is **one-shot**
(no `repeat`): the animator holds the `from` state until the unit's staggered
turn, animates it in, then holds `to`, so the headline assembles and stays put.

The motion respects the same two constraints as `background-loop` (doc 71):

1. **One animation per captured element**, so each unit is a `.kt-w-<n>`
   transform-wrapper around a `.kt-wi-<n>` opacity-inner — two distinct
   selectors, two animations that don't override each other.
2. **SVG transforms are origin-(0,0)**, so the move is an origin-safe
   `translateY` (rise) or `translateX` (slide) in `em` units; `fade` uses opacity
   only (one animation per unit).

All generation is pure and unit-tested without a browser: `planUnits` (split +
index), `buildKineticHtml`, `buildKineticAnimations`, `kineticDurationMs`.

## Code

- **`src/templates/builtin/kinetic-text.ts`** — the pure generators above plus
  the `kineticTextTemplate`. Registered in `src/templates/registry.ts`;
  re-exported from the package root.

## Follow-ups

Natural extensions on the same contract (file as needed): more reveal variants
(blur-in once blur-capture fidelity allows, per-line clip-reveal using
`clipPath`, scale-pop if a center transform-origin becomes expressible), a
loop/`repeat` mode for a continuously-cycling title, and multi-line / emphasis
(per-word color or weight) support.
