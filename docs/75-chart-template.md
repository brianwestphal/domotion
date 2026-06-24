# 75 — The `chart` built-in template

Status: **shipped** (DM-1279). A data/infographics generator — turn a list of
numbers into an animated **bar**, **column**, or **line** chart. Built on the
doc-70 template contract; the clearest "params → motion" fit, since the values
are laid out at author time and the bars grow / the line draws in via Domotion's
intra-frame `animations` (doc 08).

```sh
# Vertical bars that grow up from the baseline.
domotion template chart \
  --type column --data "42,68,55,90,34,76" \
  --labels "Jan,Feb,Mar,Apr,May,Jun" --title "Monthly signups" -o signups.svg

# Horizontal bars (labels on the left), or a line that draws in.
domotion template chart --type bar  --data "120,88,64,40" --labels "Search,Direct,Social,Email" -o traffic.svg
domotion template chart --type line --data "12,18,15,28,24,38,44" -o dau.svg
```

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `type` | `column` \| `bar` \| `line` | `column` | Vertical bars, horizontal bars, or a line. |
| `data` | number[] **or** CSV string | — | The values (**required**). |
| `labels` | string[] **or** CSV string | — | Category labels (cycled if shorter than `data`). |
| `title` | string | — | Title shown above the plot. |
| `colors` | string[] **or** CSV string | indigo/cyan/pink/amber/green/violet | Series colors, cycled across the data. |
| `max` | number | nice round value ≥ largest datum | Axis maximum. |
| `showValues` | boolean | `true` | Print each value at the bar end / point. |
| `width` / `height` | int | `1000` / `600` | Output size in px. |
| `background` / `color` | string | `#0b1020` / `#e6edf3` | Frame background / text color. |
| `growMs` | int | `750` | Grow / draw duration per element. |
| `staggerMs` | int | `110` | Delay between bars. |
| `holdMs` | int | `1800` | Hold after the chart finishes. |

`data` and `labels` (and `colors`) accept a **comma-separated string** so they
work as CLI flags (array params are otherwise JSON-only); a JSON array via
`--params` also works.

On-screen time = `(points − 1) × staggerMs + growMs + holdMs`.

## How it animates

The expensive layout (`planChart`) runs once: it computes a "nice" axis maximum
(1 / 2 / 2.5 / 5 × 10ⁿ above the largest datum) and the px geometry of every bar /
point. The motion is intra-frame `animations`:

- **column** — each bar grows up from the baseline via `transform: scaleY(0) → scaleY(1)` with `transformOrigin: "bottom"`.
- **bar** — each bar grows right from the left axis via `scaleX(0) → scaleX(1)` with `transformOrigin: "left"`.
- **line** — the line + area are one inline `<svg>` (`<polyline>` + `<path>`) revealed left-to-right by a `clipPath` wipe (`inset(0 100% 0 0) → inset(0 0% 0 0)`); the dots pop (`scale` about center) and the value labels fade in as the wipe passes each point.

A key detail (DM-1279): the grow uses **`scaleX`/`scaleY` + `transformOrigin`**, not
the `width`/`height` intra-frame properties. An intra-frame animation lands on a
`<g>` wrapper in the SVG output, where CSS `width`/`height` have no effect — but a
`transform` does, and the origin (`bottom` / `left`) pins it to the axis so the bar
grows *away* from the axis rather than from the SVG origin. This relies on the
`transformOrigin` support added in DM-1297 (doc 08).

## Code

- **`src/templates/builtin/chart.ts`** — `planChart` (pure geometry: bar rects,
  line points, nice axis max), `buildChartHtml` (pure HTML), `buildChartAnimations`
  (the grow / reveal), and the `chartTemplate`. Registered in
  `src/templates/registry.ts`; re-exported from the package root.

## Examples

`examples/templates-demo.ts` produces `chart-column.svg` / `chart-bar.svg` /
`chart-line.svg` (`examples/output/templates/`).

## Follow-ups

Filed separately: pie / donut charts, stacked + grouped (multi-series) bars,
gridlines + axis ticks, and a y-axis value scale. Each is a new `type` (or a few
params) on the same generator contract.
