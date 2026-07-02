# 85 — Brand kit (design tokens applied across templates)

**Status: shipped v1 (DM-1522 design → DM-1530 impl); logo slot + capture/animate
brand shipped (DM-1539 / DM-1540).** The `brandSchema` + `loadBrand` +
per-template `brandDefaults` + `--brand` flag are built and tested
(`src/templates/brand.ts`). The `logo` token now feeds the `cta` end-card's logo
slot (DM-1539), and `--brand` extends to `capture` / `animate` by injecting brand
CSS variables into the captured page (DM-1540 — see **docs/92**). A DM-1519
follow-up: the audience of marketing creatives needs **on-brand output at scale**
without re-specifying colors/fonts on every call.

## Goal

One reusable **brand file** of design tokens — palette, font, corner radius,
logo, background — that every built-in template reads for its **defaults**, so a
lower-third, a chart, a subscribe card, and a kinetic title all come out in the
same brand without per-call theming. Explicit params still win; the brand only
supplies defaults.

```sh
domotion template lower-third --brand acme.json --title "Live from London"
domotion template chart       --brand acme.json --data "12,19,7,25"
# → both use Acme's palette + font, no per-call color flags
```

## Token schema (`brand.json`)

A brand file is JSON (or an inline `brand` object in a config). All fields
optional; a template uses a token only where it has a matching slot.

```jsonc
{
  "palette": {
    "primary":    "#2f6df6",   // main brand color (buttons, accents, series 1)
    "accent":     "#22d3ee",   // secondary accent (highlights, bars)
    "background":  "#0b1020",   // surface behind content
    "text":       "#e6edf3",   // primary text/foreground
    "muted":      "#8b93a7"    // secondary text
  },
  "font": {
    "family":  "Inter, -apple-system, system-ui, sans-serif",
    "weights": [400, 700, 800] // used where a template picks a title/body weight
  },
  "radius":     10,             // corner radius (px) for panels/cards
  "logo":       "acme-logo.svg",// asset for templates with a logo slot (path/URL)
  "background": "linear-gradient(135deg,#1e293b,#0f172a)" // optional richer scene
                                // fill; overrides palette.background for full-bleed
}
```

Notes:
- `palette.background` is the flat surface color; the top-level `background` is an
  optional richer fill (e.g. a gradient) for full-bleed templates — it wins over
  `palette.background` where a template fills the whole canvas.
- Colors are any CSS color string (the same values templates already accept).
- `logo` resolves relative to the brand file's directory (like a config's
  relative paths).

## Precedence (the core rule)

For every template param that maps to a brand token:

```
explicit param  >  brand token  >  template's built-in default
```

Implementation consequence: the brand must be merged **before** zod applies the
schema defaults, because after parsing we can't tell a user-supplied value from a
default. The entry point does:

```
merged  = { ...template.brandDefaults(brand), ...rawUserParams }
params  = template.paramsSchema.parse(merged)   // fills any still-missing with built-in defaults
```

So `rawUserParams` (only the flags the caller actually set) override brand, and
zod fills the rest.

## Per-template mapping

Each template optionally exposes `brandDefaults(brand): Partial<Params>` mapping
brand tokens to its own param names (empty/absent → template ignores the brand).
Initial mapping for the current built-ins:

| Template | Brand token → param |
|---|---|
| **lower-third** | `accent`→`accent`, `background`→`background`, `font.family`→`fontFamily` |
| **chart** | `text`→`color`, `background`→`background`, `font.family`→`fontFamily`, `palette`→series `colors` |
| **chat** | `primary`→`accent`, `background`→`background`, `font.family`→`fontFamily` |
| **subscribe** | `primary`→`accent`, `primary`→`avatarColor`, `background`→`background`, `font.family`→`fontFamily` |
| **kinetic-text** | `text`→`color`, `background`→`background`, `font.family`→`fontFamily` |
| **background-loop** | `background`→`background`, `palette`→blob `colors` |
| **cta** (end-card) | `primary`→`ctaColor`, `background`→`background`, `text`→`textColor`, `font.family`→`fontFamily`, `logo`→`logo` (DM-1539 — the first built-in to consume `brand.logo`) |
| **device-mockup** | (no natural brand slot in v1; chrome theme stays as-is) |

`palette`→`colors` fills a template's multi-color list (chart series, background
blobs) from `[primary, accent, …]` when the caller doesn't pass explicit colors.

## Surface

- **CLI:** `--brand <file.json>` on `domotion template` (template-param
  defaults), and on `domotion capture` / `domotion animate` (CSS-variable
  injection into the captured page — **docs/92**, DM-1540).
- **Library:** `renderTemplateToSvg(template, params, { brand })` gains the
  optional `brand`; `loadBrand(path)` parses + validates a brand file (a zod
  `brandSchema`, exported for third parties + the UI).
- **UI playground (DM-1520):** would surface a brand picker that sets the same
  tokens — the schema is shared.

## Shipped after v1

- **Logo placement (DM-1539).** The `logo` token feeds the `cta` end-card's logo
  slot (`brand.logo` → the cta's `logo` param, via `brandParams`), so
  `--brand acme.json` (with a `logo`) auto-fills it. The first built-in to
  consume `brand.logo`; a `lower-third` logo variant / other slots can map it the
  same way.
- **Brand for `capture` / `animate` (DM-1540).** `--brand` on `capture` /
  `animate` injects the brand as CSS custom properties onto the captured page's
  `:root` before it paints — a distinct mechanism from template defaults. See
  **docs/92** for the variable-naming contract.

## Out of scope for v1 (future / follow-ups)

- **Multiple named brands / brand inheritance**, font *embedding* from the brand
  (vs. name reference), and per-token dark/light variants.

## Follow-up tickets

- **Implement the brand kit** — ✅ done (DM-1530): `brandSchema` + `loadBrand` +
  `brandDefaults` on the six themeable built-ins + `--brand` wiring + unit tests +
  a branded demo set (`examples/templates-demo.ts`: `brand-acme-*` across
  lower-third / chart / subscribe / kinetic from one `acme-brand.json`).
- **Logo slot wiring** — ✅ done (DM-1539): `brand.logo` → the `cta` end-card's
  `logo` param. Demo: `examples/output/templates/brand-acme-cta.svg` (one brand
  file fills the logo + button color + font, no per-call flags).
- **Brand for `capture`/`animate`** — ✅ done (DM-1540, docs/92): `--brand`
  injects brand CSS custom properties onto the captured page's `:root`. Demo:
  `examples/brand-capture-demo.ts` → `examples/output/brand-capture.svg`.

## Relationships

- **DM-1521** (format presets): orthogonal — brand sets *look*, format sets
  *canvas*. They compose (`--brand acme.json --format reel`).
- **DM-1523** (creative template pack): new templates get `brandDefaults` too.
- **DM-1520** (UI playground): shares the brand schema for its picker.
