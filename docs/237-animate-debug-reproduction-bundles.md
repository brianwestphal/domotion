---
id: "requirements/animate-debug-reproduction-bundles"
title: "Animate debug reproduction bundles"
kind: "contract"
status: "current"
owners: ["animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2636"]
code: ["src/cli/animate-command.ts","src/cli/animate-debug.ts","src/cli/animate-orchestrator.ts","src/cli/animate-capture-session.ts","src/cli/debug-bundle.ts","tests/animate-debug.e2e.test.ts"]
aliases: ["docs/237-animate-debug-reproduction-bundles.md","doc-237"]
---

# Animate debug reproduction bundles

`domotion animate --debug` extends the single-capture reproduction-bundle
contract to a multi-frame run. The bundle retains one final animation and one
network archive while preserving the source pixels and capture decisions for
each composed frame.

## Invocation and naming

```bash
domotion animate demo.json --debug -o demo.svg
domotion animate demo.json --debug-dir repro -o demo.svg
```

Plain `--debug` derives `<output-stem>.debug/` from the CLI or config `output`.
It is an error when neither supplies an output. `--debug-dir` both enables debug
and supplies the destination, so it also works when normal output naming is
implicit. Capture and animate share this validation and naming helper.

## Bundle layout

```text
demo.debug/
  capture.har
  actual.svg
  frames/
    000/
      expected.png
      captured-tree.json
    001/
      expected.png
      captured-tree.json
```

- `capture.har` is one Playwright `mode: "minimal"` archive from the persistent
  animation capture context. Continued frames therefore preserve one browser
  and one network history instead of producing independent archives. The
  context is closed explicitly before the CLI returns so the HAR is flushed.
- `actual.svg` is the final plain SVG text after optional optimization. It stays
  plain XML even when the requested delivery artifact is `.svgz` or stdout.
- `expected.png` is a 1× Chromium screenshot at the configured animation canvas
  size. For a DOM-backed frame it records the live page after readiness and
  actions. For an embedded cast/template frame it records the exact nested SVG
  source at time zero in a separate headless page.
- `captured-tree.json` is the raw captured element-tree array when the frame has
  one. It is JSON `null` for an embedded frame or a compound capture such as a
  scroll/states/resample frame, where no single tree can honestly represent the
  frame content. The file is always present; consumers never infer absence from
  a missing artifact.

Frame directories use zero-based, minimum-three-digit indices and follow the
frames that reach the composed animation after config interpolation and run
compression. The shared HAR covers page-backed capture; embedded frames are
already self-contained in `actual.svg` and their per-frame Chromium raster.

## Safety and compatibility

Debug mode changes evidence collection only. It does not change frame timing,
transitions, capture routing, optimization, or output compression. The normal
animate output is written through the existing artifact path, then its final
plain SVG is copied into the bundle. All Chromium launched by capture and tests
is headless; debug mode does not open SVG Review, SVG Scrubber, or the system
browser.

The raw tree remains an inspection artifact rather than a public schema. The
stable hand-off contract is the filenames, one shared HAR, and a complete
PNG/tree pair per composed frame.
