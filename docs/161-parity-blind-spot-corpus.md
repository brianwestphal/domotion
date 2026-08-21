# 161 — Parity blind-spot corpus

DM-2372 adds `35-parity-blind-spots.html` as a pinned fixture injected into every macOS, Linux, and Windows html-test clone. One deterministic page composes SVG effect boxes, CSS masks/clips, an opaque-origin scrollable iframe, fragmented backgrounds and tables, bidi/emoji overrides, MathML and font fallback, native controls, nested projective transforms, filters/blends, CSS zoom, and interacting fallback routes.

`tools/html-test-parity-corpus.json` owns the stable corpus id, category inventory, and SHA-256. CI records `id:sha256` in `run-env.json`; shard merging and baseline comparison reject different corpus identities. This keeps a green result tied to the exact bytes measured rather than merely a filename from a moving external clone.
