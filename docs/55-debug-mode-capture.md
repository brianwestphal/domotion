# Debug-mode capture

`domotion capture --debug` writes a reproduction bundle alongside the
output SVG containing everything a maintainer needs to reproduce a
fidelity bug locally — without needing access to the source page's
network state. It's the consumer-side counterpart to the in-repo
`tests/cache/real-world/*.har` fixtures we use for the regression suite,
and feeds directly into the `svg-review` CLI documented in doc 54.

## What gets written

When `--debug` (or `--debug-dir <path>`) is passed, the CLI creates a
sibling folder next to the output (default `<output-name>.debug/`) and
populates it with four artifacts:

| File | Source | Used by |
|---|---|---|
| `capture.har` | Playwright `recordHar: { mode: "minimal" }` | offline replay via `domotion capture <foo.har>` |
| `expected.png` | `page.screenshot()` of the clip rect | `svg-review` as the expected image |
| `actual.svg` | copy of the produced SVG | `svg-review` as the actual SVG |
| `captured-tree.json` | the intermediate element tree (pre-render) | maintainer inspection of capture decisions |

The final log line of a `--debug` run tells the user exactly which
`svg-review` invocation will open the bundle:

```
Review with: svg-review --expected foo.debug/expected.png --actual foo.debug/actual.svg
```

## Invocation

```
domotion capture <input> --debug -o out.svg
domotion capture <input> --debug-dir my-bundle/ -o out.svg
```

`--debug` requires `--output` (so the debug folder name can be derived);
`--debug-dir <path>` makes that requirement explicit and overrides the
default `<output>.debug/` location.

## Why HAR + screenshot together

Either artifact alone is incomplete:

- **HAR alone**: lets the maintainer reproduce the network state, but
  they still have to capture a fresh Chromium screenshot to know what
  the source page actually looked like at the consumer's viewport /
  font stack / time-of-capture. Two extra steps for the maintainer
  before they can diff.
- **Screenshot alone**: the maintainer sees the visual goal but can't
  reproduce the DOM (the page may have changed since the bug was
  filed, or required login / live data the maintainer doesn't have).
  No way to iterate on a fix.

Together they're a closed system: replay the HAR, run our capture, diff
the resulting SVG against the bundled `expected.png`. That's exactly the
loop the in-repo real-world fixtures already use, just packaged for
consumer hand-off.

## Relationship to `svg-review` (DM-946)

`--debug` was scoped to land alongside `svg-review` per the maintainer's
direction on DM-946: a consumer hits a fidelity issue, runs the capture
once with `--debug` to produce the bundle, then runs `svg-review` to
visually annotate the regions that matter and copy a GitHub-issue-ready
Markdown block. The two tools share `expected.png` + `actual.svg` as
the file contract; nothing else in the bundle is `svg-review`-specific.

## Not in v1 (deferred)

- **API surface**: there's no programmatic `captureElementTree({ debug
  : true })` equivalent yet. The CLI flag covers the consumer flow
  (`npx domotion capture …`); programmatic consumers can replicate by
  passing their own `recordHar` to the context they create.
- **Per-frame artifacts for `animate`**: `domotion animate --debug` is
  not yet wired up. Same artifact set applies in principle (one
  expected.png + captured-tree.json per frame, one shared HAR); track
  as a follow-up if a consumer asks.
- **Tree dump format**: `captured-tree.json` is the raw element-tree
  JSON. It's stable enough for issue triage but not a public schema —
  treat it as an opaque artifact attached to a bug.

## Follow-up tickets

- **DM-XXX (animate --debug)** — extend the bundle to the animate
  subcommand (per-frame expected.png + tree + one shared HAR).
- **DM-XXX (API debug option)** — programmatic equivalent for the
  `captureElementTree`/`elementTreeToSvg` callers who already manage
  their own browser context.
