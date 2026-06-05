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
| `progress-install/` | **`cut`** transitions between terminal states, a **typing overlay** that types a command, and an **intra-frame `animations`** entry that fills a progress bar (`width` 0%→100%). |
| `slides-pushleft/` | A **`push-left`** transition across three slides — each slides in from the right while the previous slides off to the left. |
| `scroll-feed/` | A **`scroll` block**: one tall page captured at multiple scroll positions via the pattern grammar (`down:bottom/6s`) and composed into one scrolling SVG. The sticky header stays put while the feed scrolls. |
| `svg-overlay/` | A **`kind: "svg"` overlay** — a separately-authored `badge.svg` inlined into the frame (its ids namespaced to avoid collisions) and slid in from the bottom with the `enter` sugar. |

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
