# MathML native-helper ink evidence

MathML token placement uses `measureInkMetrics` to divide the captured token box around the baseline by the ink ascent/descent of the glyphs that are actually emitted. The measurement follows the same fallback-run splitter as text rendering; it must not substitute the primary font's ascent when a token routes to a platform-native helper face.

Native helpers already return each glyph's exact CoreText/FreeType/DirectWrite bounding box with its outline. `src/render/glyph-helper.ts` preserves that box in the font-like glyph record, translated by the same helper outline-origin correction as its commands, and carries it from coverage lookup into shaped glyphs. `measureInkMetrics` therefore consumes the selected helper glyph bbox through the same `glyph.bbox` interface as fontkit-backed faces. Whitespace and `.notdef` remain excluded.

Focused controls cover a STIX math operator, a Han token that falls back by script, and a mixed Latin/Han token whose union must be taller than the Latin x-height without reaching the full font ascent. This is evidence/placement plumbing only; it does not change fallback selection or introduce a MathML-specific font route.
