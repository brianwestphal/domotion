# Code map for AI agents

Read `CLAUDE.md` first. This page is deliberately compact; use the generated
[manifest](manifest.json) or an on-demand [domain packet](packets/) instead of
loading the historical documentation corpus.

## Main pipeline

- `src/capture/` owns browser bring-up, DOM/style/geometry collection, source
  evidence, replaced/native surfaces, and the serialized page capture script.
- `src/render/` turns captured facts into SVG. It must preserve Chromium's
  decisions; it does not independently lay out the page.
- `src/animation/`, `src/composite/`, and `src/scroll/` compose static captures
  into timed frames, nested scenes, and scrolling outputs.
- `src/terminal/` and `src/templates/` are authoring front ends that reuse the
  same render/animation pipeline.
- `src/post-processing/` exports the self-contained SVG to raster or video.
- `src/review/` and `src/scrubber/` provide local review and timeline UIs.
- `src/cli/` exposes capture, animate, template, terminal, review, and scrubber
  workflows.

## Correctness and evidence

- `tests/feature-coverage.ts` maps supported behaviors to asserting tests.
- `tools/parity-program.json` and `tools/semantic-coverage.json` inventory
  source ownership, stage gates, activation, platform coverage, and gaps.
- `tools/*oracle*`, `tools/*gate*`, and `.github/workflows/` produce and
  adjudicate exact logical, native, and visual evidence.
- `external/chromium`, pinned Skia, HarfBuzz, ICU, and platform-native helpers
  are the authority for fidelity work. Cite the governing decision before
  changing a parity branch.
- Generated client/capture bundles must be rebuilt with their package scripts
  and committed with their source.

## Domain routing

- [Text and fonts](../handbook/text-and-fonts.md)
- [Layout and fragmentation](../handbook/layout-and-fragmentation.md)
- [Paint, effects, and native controls](../handbook/paint-effects-and-native-controls.md)
- [Images, media, and embedding](../handbook/images-media-and-embedding.md)
- [Animation and interaction](../handbook/animation-and-interaction.md)
- [Platforms, testing, and release](../handbook/platforms-testing-and-release.md)

Search the [manifest](manifest.json) by stable ID or code path, then open only
the handbook and current reference/evidence records relevant to the change.
