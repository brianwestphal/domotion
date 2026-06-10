# 59 — Single source of truth for overlay / animation shapes

Status: **shipped** (DM-1131). The overlay and intra-frame-animation shapes are
defined once as zod schemas in `src/animation/overlay-schema.ts`; the renderer's
runtime TypeScript types are `z.infer`red from them, and the declarative-config
validator (`src/cli/animate.ts`) extends the same base schemas. One definition,
two derived views.

## Why

Before this, the same shapes were defined **twice, independently**:

- the renderer hand-wrote `TypingOverlay` / `AnimationOverlay` / … as TS
  `interface`s in `animator.ts`;
- the CLI config hand-wrote a parallel zod `overlaySchema` (with `anchor` /
  `maxWidth`) inside `animateConfigSchema`.

Because the two were unrelated, a rename or removal on one side was invisible to
the other — no domotion build caught the drift. The concrete failure that
motivated the ticket: the bare `Overlay` union/member type that earlier versions
exported was renamed (`Overlay` → `AnimationOverlay`, member → `TypingOverlay`),
a downstream consumer imported `Overlay`, and the broken import surfaced only in
that consumer's build, never in domotion's.

## Design — one base, two views

```
src/animation/overlay-schema.ts        ← SSOT (zod)
   typingOverlaySchema, tapOverlaySchema, svgOverlaySchema,
   blinkOverlaySchema, animationOverlaySchema, intraFrameAnimationSchema
   export type TypingOverlay = z.infer<typeof typingOverlaySchema>   (resolved/runtime view)
        │                                   │
        │ z.infer                           │ .extend({...})
        ▼                                   ▼
src/animation/animator.ts            src/cli/animate.ts
   re-exports the resolved types        authoring schemas =
   that generateAnimatedSvg consumes    base.extend({ x:default(0), y:default(0),
                                                       anchor?, maxWidth? })
                                        → animateConfigSchema → schemas/animate-config.schema.json
```

- **Resolved view** (the base schemas): concrete `x` / `y`, no selector
  `anchor`. This is exactly what `generateAnimatedSvg` consumes. The public
  package types (`TypingOverlay`, `TapOverlay`, `SvgOverlay`, `AnimationOverlay`,
  `IntraFrameAnimation`) are `z.infer` of these and are re-exported unchanged
  from `domotion-svg`.
- **Authoring view** (CLI): `src/cli/animate.ts` builds each overlay's config
  schema by **extending** the matching base — adding the config-only
  conveniences (`x` / `y` defaulted to `0` so an `anchor` can supply them; the
  selector `anchor`; the typing `maxWidth`). The `svg` kind is the one exception:
  authoring takes a `src` file path that the CLI reads / namespaces into the
  runtime `innerSvg` + `animId` (`resolveSvgOverlays`), so its authoring schema
  is its own shape rather than a structural extension. Intra-frame animations
  follow the same pattern — `intraFrameAnimationSchema.omit({ animId }).extend({
  selector })` — since the config addresses elements by selector and the runner
  resolves selector → `animId`.

## What this buys

- **Renames cascade at compile time.** Rename a field on a base schema and every
  consumer moves with it or fails to build: the renderer's `z.infer` type
  changes (so `renderTypingOverlay` reading the old name errors), and the CLI's
  `.extend(...)` / `resolveOverlayAnchors` references to the old name error.
  There is no longer a second hand-written copy that silently keeps the old name.
- **The JSON Schema can't drift from the validator.** `schemas/animate-config
  .schema.json` is generated from `animateConfigSchema` (which now references the
  shared bases) by `scripts/generate-animate-schema.ts`, and
  `src/cli/animate-config-json-schema.test.ts` fails if the committed copy is out
  of sync — run `npm run build:animate-schema` and commit the regenerated file.
- **The resolved/authoring split is explicit**, which is the foundation the
  overlay-resolution primitive (DM-1132) builds on: an authoring overlay
  (`anchor` / `maxWidth`) is lowered to a resolved overlay (`x` / `y` /
  `bgWidth`) by the resolution step, and both sides now name the same schema.

## Field docs

The per-field documentation lives as comments in `overlay-schema.ts`; `z.infer`
does not carry JSDoc onto the emitted `.d.ts`, so the consumer-facing contract is
`docs/api.md` (the type rows) plus `docs/08-animation-model.md` /
`docs/43-declarative-animate-config.md`. Keep the schema's field set in lockstep
with those docs.

## Follow-ups

- **DM-1134** — reconcile the typing-overlay wrap-vs-mask knobs (`bgWidth` means
  "mask only" in the CLI where `maxWidth` wraps, but "mask + wrap" in the
  runtime). That field-set unification is a **breaking** change to the
  typing-overlay shape and is tracked separately; doing it on top of this SSOT is
  most of the work-once-here.
- **DM-1132** — expose the authoring→resolved resolution (`resolveOverlays`) as a
  public primitive so imperative callers get selector anchoring too.
