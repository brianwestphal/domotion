# Exact shaping oracle

`npm run fonts:shaping:exact` is Domotion's glyph-level, pre-raster shaping gate. It exists because Chromium's CDP font domain reports the selected face and glyph count, but not glyph IDs, clusters, positions, or flags.

The reference is the vendored HarfBuzz build made with Chromium's configuration. This is a source-equivalent oracle, not a pixel proxy: Chromium revision `7d859f27` constructs an `hb_buffer_t` in `third_party/blink/renderer/platform/fonts/shaping/harfbuzz_shaper.cc`, and the vendored build uses HarfBuzz revision `4de187d` without `HB_TINY`/`HB_NO_AAT`. The tool records the exact concrete file/member/axes and applies explicit direction, script, language, BOT/EOT flags, monotone-character cluster level, features, and ptem inputs for its host/source control contract. Blink itself does not set a cluster level after creating or resetting its buffer at this pin, so its browser default is HarfBuzz `MONOTONE_GRAPHEMES`; doc 220 owns the focused browser-substitution proof under that actual default. Skia is downstream of this boundary and rasterization is deliberately out of scope.

Each JSON record contains:

- platform, architecture, Node/ICU/HarfBuzz/Chromium-package identity, zoom, and device scale;
- concrete font path, collection member, named instance, and resolved axes;
- text and UTF-16 span, direction, script, language, features, buffer flags, and cluster level;
- fallback-run boundaries;
- glyph IDs/order, UTF-16 clusters/source spans, x/y advances, x/y offsets, raw glyph flags, and `unsafeToBreak`.

No numeric tolerance is applied. The oracle compares logical integers emitted by the same HarfBuzz ABI Chromium uses; representation-only normalization is limited to deriving a UTF-16 source span from equal cluster indices. Pixel thresholds cannot turn a logical mismatch into a pass.

Schema v3 emits `exact-logical-agreement`, `logical-mismatch`, or `verdict-withheld` independently of pixels. Every host record carries the complete parity fingerprint from doc 120: Chromium/flags, OS/architecture, font-inventory digest, locale/preferences, helper route/build recipe, Node/ICU/Unicode and source revisions, viewport inputs, and corpus/sample/cache identity. The report preserves aggregate `controlHits`/`missedControls` and additionally separates host hits from the source-owned applicability rows described in doc 199. Missing fixtures, applicable-but-inert inputs, and unexpected logical mutations are distinct fail-closed states. `--skip-negative-control` is a test seam that must produce `verdict-withheld` and a failing exit status.

## Profiles

```sh
# Fast representative gate; writes machine-readable evidence.
npm run fonts:shaping:exact -- --json tests/output/shaping-exact.json

# All corpus samples and all mandatory sensitivity controls.
npm run fonts:shaping:exact -- --exhaustive --json tests/output/shaping-exact-full.json

# A rotating CI slice can select a stable face family.
npm run fonts:shaping:exact -- --rotating --face noto
```

The tool runs on macOS, Linux, and Windows against that host's routing table. Every profile requires all nine aggregate controls—face, axes, ptem, features, direction, script, language, buffer flags, and cluster level—to change the answer. Host routes exercise the production inventory. Two pinned Open Sans omission rows and the upstream HarfBuzz `STAT`+`trak` omission row guarantee applicable axes/ptem inputs even on a static Linux image; they remain separate from host `records`/`pairs` and must change only `xAdvance` across the complete expected logical stream. A control that does not produce its exact expected delta fails the gate. Axis-bearing host faces, collection members, vertical/CJK, emoji sequences, bidi controls, and synthetic-trait fixtures remain explicit corpus dimensions rather than inferred platform equivalence.

The existing `fonts:shaping` browser harness remains the stage before this oracle: it proves the concrete face and browser geometry. `fonts:shaping:exact` starts after that face-selection boundary and proves the logical glyph stream. Layout/placement and rasterization are later stages and must be reported separately.

Doc 220 adds the missing strict browser-substitution join. Its four portable
OpenType fixtures exercise `liga`, `rlig`, contextual forms, GPOS mark
attachment, variation axes, and `locl` language systems under Blink's actual
monotone-grapheme default. CDP authenticates the sole exact custom face and
glyph count; pinned HarfBuzz and production provenance over those same bytes
must agree on every gid/cluster/span/advance/offset field before a six-artifact
macOS/Linux/Windows proposal/validation aggregate can pass. That gate remains
pre-raster and changes neither this oracle's inputs nor any pixel tolerance.
