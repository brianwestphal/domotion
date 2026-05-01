# Domotion docs

Requirements / design docs for the rendering pipeline. Numbered to match the order they were authored; numbering does not imply dependency order.

> **Cross-platform note**: Domotion is an npm package and is expected to function on macOS, Linux, and Windows. Today the rendering pipeline is fully calibrated only against Chromium-on-macOS (CoreText-based fallback chain); Linux (fontconfig — Noto / DejaVu / Liberation) and Windows (DirectWrite — Arial / Consolas / Segoe UI Symbol / Cambria Math) calibration is roadmap work tracked in DM-258 (path discovery) → DM-259 (Linux) / DM-260 (Windows) / DM-261 (bundled fallback fonts) → DM-262 (per-platform CI). Treat any macOS-only code path as debt to flag, not a design choice — match Chromium's actual painted output on each target platform.

| Doc | Topic |
|---|---|
| [01-fidelity.md](01-fidelity.md) | Overall rendering-fidelity contract: what CSS features round-trip, what's partial, what isn't supported. The big-picture support matrix. |
| [02-writing-mode.md](02-writing-mode.md) | CSS `writing-mode` (vertical-rl / vertical-lr / sideways-*). Currently uses element-raster fallback. |
| [03-font-family-chain.md](03-font-family-chain.md) | Honoring author-specified font-family chains (e.g. `"Helvetica Neue", "Times New Roman", monospace`). |
| [04-input-pseudos.md](04-input-pseudos.md) | Author-styled `<input>` shadow-DOM pseudos (range track/thumb, checkbox/radio, color swatch, etc.). |
| [05-progress-meter-pseudos.md](05-progress-meter-pseudos.md) | Author-styled `<progress>` and `<meter>` pseudos via the stylesheet walker. |
| [06-css-transforms.md](06-css-transforms.md) | CSS 2D `transform` (rotate / scale / skew / matrix) on rendered SVG groups. |
| [07-gradient-fills.md](07-gradient-fills.md) | CSS `linear-gradient` / `radial-gradient` → SVG `<linearGradient>` / `<radialGradient>` with px-positioned stops. |
| [08-animation-model.md](08-animation-model.md) | Animated-SVG composition: transitions (`crossfade` / `push-left` / `scroll` / `cut`), per-frame overlays, intra-frame property animations, frame-local SVG overlays, slide-in entrance sugar. |
| [09-vertical-range.md](09-vertical-range.md) | Vertical-axis `<input type=range>` via `writing-mode: vertical-*` + `direction` semantics. |
| [10-repeating-gradients.md](10-repeating-gradients.md) | `repeating-linear-gradient` / `repeating-radial-gradient` and `calc(N% ± Mpx)` stop positions. |
| [11-custom-checkbox-radio.md](11-custom-checkbox-radio.md) | `appearance: none` checkbox / radio / switch — host-element rect shows through, indicator overlaid in author colors, switch-shape detection. |
| [12-diff-scoring.md](12-diff-scoring.md) | `tests/html-test-suite.tsx` visual-diff metric — Yee anti-aliasing filter, threshold rationale, diff-image legend. |
| [13-cursor-overlay.md](13-cursor-overlay.md) | Cursor / touch / click overlay simulation API — proposed design, awaiting feedback (DM-277). |
| [14-per-corner-border-radius.md](14-per-corner-border-radius.md) | Per-corner border-radius (asymmetric `10px 30px 50px 70px` and elliptical `50px / 20px`) — capture format, corner-overlap clamp, inner-radius derivation, path geometry. |
| [16-coretext-glyph-extraction.md](16-coretext-glyph-extraction.md) | Native glyph-outline extraction via CoreText / Pango / DirectWrite for fonts whose outlines fontkit can't parse (PingFang's `hvgl`, Apple-private formats). Helper-binary architecture, IPC protocol, cross-platform plan. |

The docs preserve their historical SK-XXXX references — those are the slicekit Hot Sheet tickets that originally drove each feature. Treat the ticket numbers as opaque pointers to design context, not as live work tracking.
