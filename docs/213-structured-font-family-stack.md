---
id: "requirements/structured-font-family-stack"
title: "Structured captured font-family stack"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: []
tickets: ["DM-2518"]
code: ["src/font-family-stack.test.ts","src/font-family-stack.ts","tests/font-family-stack-capture.e2e.test.ts"]
aliases: ["docs/213-structured-font-family-stack.md","doc-213"]
---

# Structured captured font-family stack

## Contract

DM-2518 carries one decoded, typed font-family list from capture to every text
paint owner. The structured record is authoritative; the former CSSOM string
remains only for compatibility with older serialized trees.

This is a logical font-selection correction. It changes no screenshot score,
pixel tolerance, native-raster envelope, or host-font answer table.

## Pinned Blink ownership

The implementation is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `platform/fonts/font_family.{h,cc}` stores each linked-list node as either
  `kFamilyName` or `kGenericFamily`, with the decoded name rather than its CSS
  quoting or escape spelling.
- `core/css/resolver/style_builder_converter.cc::ConvertFontFamily` walks the
  CSS list in reverse. The first enum-bearing generic it encounters becomes
  `FontDescription::GenericFamily`, so the rightmost legacy generic wins.
  `system-ui` and `math` are generic list nodes but do not occupy that legacy
  enum.
- `core/css/properties/computed_style_utils.cc::ValueForFamily` serializes
  generic nodes as identifiers and literal nodes as CSS font-family values.
  Quoted generic-looking literals therefore remain distinguishable from bare
  generics in computed style.

HarfBuzz and Skia receive a face after this decision; neither can reconstruct a
lost CSS list-node type. The information must therefore be retained at capture
and consumed before Domotion resolves or shapes the run.

## Record and parser

`src/font-family-stack.ts` owns the browser-safe record:

```ts
{
  source: "blink-font-family-stack-v1",
  entries: Array<{ name: string; type: "family-name" | "generic-family" }>,
  genericFamily: "none" | "standard" | "webkit-body" |
    "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy"
}
```

The CSS-aware tokenizer does not split quoted or escaped commas, decodes CSS
identifier/string escapes including hexadecimal escapes and escaped newlines,
and classifies a generic only when the computed token is an unquoted canonical
generic identifier. Literal names serialize quoted on output; only typed
generic nodes serialize bare. That makes a round trip unambiguous even for
`"monospace"`, `"A, B"`, and `Escaped\,Name`.

Blink's initial `kStandardFamily` has no faithful concrete CSSOM spelling.
Capture represents it as one typed `-webkit-standard` node with descriptor
generic `standard`. Generated/first-letter/first-line/line-clamp paths inherit
that host record when their computed family is inherited. A matching authored
pseudo family declaration prevents the inheritance rewrite even when it
resolves to the same concrete settings face; this is the same-face mutation
control that a computed string alone cannot pass.

## Owner matrix

The record is captured and consumed for:

- ordinary element styles and ordinary horizontal/vertical text;
- exact `::before`/`::after` pseudo-fragment typography and legacy generated
  segments;
- styled `::first-letter` and `::first-line` segments;
- generated `-webkit-line-clamp` ellipsis segments;
- input/textarea placeholder text;
- listbox option rows, closed select display text, and captured file-selector
  button/status text;
- emoji raster-selection checks, emphasis marks, decorations, named
  `@font-feature-values`, palette ownership, and font-metric alias probes.

All renderer entry points call the shared serializer before face resolution.
If the structured field is absent, the legacy string is retained unchanged so
previous capture files remain readable.

## Exact gates

`src/font-family-stack.test.ts` covers quoted commas, escaped names, hexadecimal
escapes, quoted generic-looking literals, rightmost legacy generic semantics,
non-occupying `system-ui`/`math`, the standard sentinel, round-trip identity,
and hostile raw-string/node-type mutations.

`tests/font-family-stack-capture.e2e.test.ts` captures the same authored stack
through ordinary, generated, first-letter, line-clamp, placeholder, and
listbox owners. Its UA-default arm requires inherited standard identity across
ordinary/generated/first-letter/clamp owners, while an authored same-face
pseudo must remain a literal family node. The assertions compare decoded
entries and descriptor semantics only—there is no pixel assertion or
tolerance.

The generated capture script is rebuilt twice and must have the same SHA-256
before handoff.
