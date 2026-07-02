# 85 — Brand kit (design tokens applied across templates)

**Status: design (DM-1522).** Implementation tracked in follow-up tickets (see
end). A DM-1519 follow-up: the audience of marketing creatives needs **on-brand
output at scale** without re-specifying colors/fonts on every call.

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
| **device-mockup** | (no natural brand slot in v1; chrome theme stays as-is) |

`palette`→`colors` fills a template's multi-color list (chart series, background
blobs) from `[primary, accent, …]` when the caller doesn't pass explicit colors.

## Surface

- **CLI:** a global-ish `--brand <file.json>` on `domotion template`. (Extending
  it to `animate`/`capture` is future — see below.)
- **Library:** `renderTemplateToSvg(template, params, { brand })` gains the
  optional `brand`; `loadBrand(path)` parses + validates a brand file (a zod
  `brandSchema`, exported for third parties + the UI).
- **UI playground (DM-1520):** would surface a brand picker that sets the same
  tokens — the schema is shared.

## Out of scope for v1 (future / follow-ups)

- **Logo placement.** The `logo` token is in the schema, but no current template
  has a logo slot. Wiring it lands with templates that do (lower-third logo
  variant, the CTA/end-card in DM-1523).
- **Brand for `capture` / `animate`.** Theming a *captured* real page (vs a
  generated template) means injecting brand CSS variables before capture — a
  distinct mechanism; deferred.
- **Multiple named brands / brand inheritance**, font *embedding* from the brand
  (vs. name reference), and per-token dark/light variants.

## Follow-up tickets

- **Implement the brand kit** (schema + `loadBrand` + `brandDefaults` on each
  built-in + `--brand` wiring + tests + a branded demo set).
- **Logo slot wiring** (once a template with a logo slot exists — coordinate with
  DM-1523's end-card / a lower-third logo variant).
- **Brand for `capture`/`animate`** (inject brand CSS custom properties).

## Relationships

- **DM-1521** (format presets): orthogonal — brand sets *look*, format sets
  *canvas*. They compose (`--brand acme.json --format reel`).
- **DM-1523** (creative template pack): new templates get `brandDefaults` too.
- **DM-1520** (UI playground): shares the brand schema for its picker.
