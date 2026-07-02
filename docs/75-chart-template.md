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
| `type` | `column` \| `bar` \| `line` \| `pie` \| `donut` | `column` | Bars (vertical/horizontal), a line, or a pie / donut. |
| `data` | number[] / number[][] / string | — | One or more series (**required**). See below. |
| `labels` | string[] **or** CSV string | — | Category labels (cycled if shorter than the data). |
| `seriesNames` | string[] **or** CSV string | — | Legend names, one per series (multi-series only). |
| `layout` | `grouped` \| `stacked` | `grouped` | Multi-series bars: side-by-side or stacked. |
| `title` | string | — | Title shown above the plot. |
| `colors` | string[] **or** CSV string | indigo/cyan/pink/amber/green/violet | Per-**series** when multi-series, else per-bar. |
| `max` | number | nice round value ≥ largest datum | Axis maximum. |
| `yTicks` | int | `4` | Value-axis gridline / tick divisions (`0` disables the scale). |
| `showValues` | boolean | `true` | Print each value at the bar end / point (single series only). |
| `width` / `height` | int | `1000` / `600` | Output size in px. |
| `background` / `color` | string | `#0b1020` / `#e6edf3` | Frame background / text color. |
| `fontFamily` | string | `-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif` | Font for the title / labels / values. |
| `growMs` | int | `750` | Grow / draw duration per element. |
| `staggerMs` | int | `110` | Delay between categories. |
| `holdMs` | int | `1800` | Hold after the chart finishes. |

**`data` shapes (DM-1301).** A single series is a `number[]` (or CSV `"1,2,3"`).
**Multiple series** are a `number[][]` (or a string with `;` between series:
`"1,2,3;4,5,6"`). With more than one series, the chart draws a **legend**
(`seriesNames`, or "Series N"), colors **per series**, and lays bars either
**grouped** (side-by-side) or **stacked** (`layout`). Lines draw one polyline per
series. Per-bar value labels are shown only for a single series — multi-series
relies on the value-axis scale.

**Value-axis scale + gridlines (DM-1301).** `yTicks` (default 4) draws faint
gridlines behind the plot at the nice-max divisions with tick labels on the value
axis — horizontal (left labels) for `column` / `line`, vertical (bottom labels)
for `bar`. `yTicks: 0` removes them.

On-screen time = `(categories − 1) × staggerMs + growMs + holdMs`.

## How it animates

The expensive layout (`planChart`) runs once: it computes a "nice" axis maximum
(1 / 2 / 2.5 / 5 × 10ⁿ above the largest datum) and the px geometry of every bar /
point. The motion is intra-frame `animations`:

- **column** — each bar grows up from the baseline via `transform: scaleY(0) → scaleY(1)` with `transformOrigin: "bottom"`.
- **bar** — each bar grows right from the left axis via `scaleX(0) → scaleX(1)` with `transformOrigin: "left"`.
- **line** — each series is a `<g class="ch-reveal-N">` inside one inline `<svg>` (`<polyline>` + area `<path>`), revealed left-to-right by a `clipPath` wipe (`inset(0 100% 0 0) → inset(0 0% 0 0)`); the dots pop (`scale` about center) as the wipe passes each point.
- **stacked** — a whole category's segments live in one `.ch-stack-N` container that scales up as a unit (`scaleY`/`scaleX` about the axis), so the segments rise together in proportion rather than each from its own floating bottom.

- **pie / donut** — each slice is an SVG `<path>` arc (a wedge, or a ring segment for `donut`). The whole pie spins + scales into place as one `.ch-pie-group` (`transform: scale + rotate` about center) while the slices fade in staggered clockwise — a sweep. A vertical legend shows each slice's **label + percentage**. (`pie`/`donut` take one series; the axis/gridline params don't apply.)

The grow is staggered by **category** (`catIdx × staggerMs`), giving a left-to-right sweep across the categories.

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
`chart-line.svg`, the multi-series `chart-grouped.svg` / `chart-stacked.svg`, and
`chart-donut.svg` (`examples/output/templates/`).

## Format awareness

With a `--format` preset (docs/87) the chart lays its plot out within the safe
rect (`canvas − safeInset`, DM-1537) **and** scales its type per ratio: the
adaptive `formatScaleFactor` (docs/91, DM-1560) enlarges the title / axis-tick /
value-label / category-label / legend font sizes and the single-series
bar-thickness cap so a landscape-tuned chart reads well at 9:16, not just fits.
With no format the scale factor is exactly `1`, so the default output is
byte-identical. See `examples/output/templates/format-square-chart.svg` (1:1) and
the reel/landscape rendered-SVG checks in docs/91.

## Follow-ups

The chart type set is complete: `column` / `bar` / `line` / `pie` / `donut`,
single- or multi-series (grouped/stacked, DM-1301), with a value-axis scale +
gridlines and a legend. Pie/donut shipped in DM-1300.
