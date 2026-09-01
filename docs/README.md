# Domotion documentation

Start with the current domain handbook for the behavior you are changing. The
numbered files are stable reference/evidence aliases retained for old links and
ticket provenance; their numbers record authoring history, not reading order.

## Current domain handbooks

- [Text and fonts](handbook/text-and-fonts.md)
- [Layout and fragmentation](handbook/layout-and-fragmentation.md)
- [Paint, effects, and native controls](handbook/paint-effects-and-native-controls.md)
- [Images, media, and embedding](handbook/images-media-and-embedding.md)
- [Animation and interaction](handbook/animation-and-interaction.md)
- [Platforms, testing, and release](handbook/platforms-testing-and-release.md)

## Reference and evidence

- [Generated current topic index](generated-index.md) — current/partial
  contracts, references, and evidence grouped by owner.
- [Historical and superseded index](archive/index.md) — proposals,
  investigations, retired pages, and superseded records. Files remain at their
  historical paths so links continue to work.
- [Machine-readable index](index.json) — complete metadata and historical-number
  alias map.
- [Public API](api.md) and [product feature matrix](../FEATURES.md).
- [Documentation architecture review](documentation-architecture-review.md).

## Working with the corpus

The stable front-matter `id`, not the filename number, identifies a requirement.
Every numbered document and handbook declares lifecycle, owners, platforms,
tickets, code paths, and aliases. Run:

```bash
npm run docs:index:check
```

The check rejects invalid metadata, duplicate IDs, broken internal links, stale
generated views, oversized default-context pages/handbooks, and every missing
code/test path declared by a current or partial record. Historical records may
retain removed paths as evidence. Regenerate after metadata changes with
`npm run docs:index:generate`.

macOS, Linux, and Windows are first-class supported capture platforms. Platform
evidence must state the exact OS, architecture, browser, font inventory, and
native helper where those facts affect comparability.
