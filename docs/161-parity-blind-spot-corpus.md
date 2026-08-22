# 161 — Parity blind-spot corpus

`35-parity-blind-spots.html` is a pinned fixture injected into every macOS, Linux, and Windows html-test clone. One deterministic page composes SVG effect boxes, CSS masks/clips, an opaque-origin scrollable iframe, fragmented backgrounds and tables, bidi/emoji overrides, MathML and font fallback, native controls, nested projective transforms, filters/blends, CSS zoom, and interacting fallback routes.

`tools/html-test-parity-corpus.json` owns the stable corpus ids, category inventories, metamorphic-axis inventory, and SHA-256 values. CI records the digest of every ordered `id:sha256` pair in `run-env.json`; shard merging and baseline comparison reject different corpus identities. This keeps a green result tied to the exact bytes measured rather than merely a filename from a moving external clone.

The v2 manifest also pins `36-composed-metamorphic-parity.html`. That second page and its seven focused repository siblings add explicit neutral-wrapper, equivalent-syntax, node-split, translation, scale, and DOM-order relations across multilingual layout, controls/fragmentation, masks/clips/stacking, SVG effects, zoom/transforms, same-origin iframes, and capture-frozen canvas pixels. [Doc 183](183-composed-metamorphic-parity-corpus.md) defines its live relation gate, fresh-process fixture isolation, and hard three-platform workflow.
