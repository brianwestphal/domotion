# MathML italic-token logical oracle

DM-2441 adds `npm run fonts:mathml-italic`, a browser-backed logical oracle for
MathML `<mi>` transformation and shaping. Each row joins the original DOM
scalar to Chromium's computed `text-transform`, the captured scalar, Range and
token geometry, CDP's painted PostScript face, helper face/source provenance,
glyph id, advance and offsets, and the final captured baseline.

The matrix covers ASCII and Greek letters, the exceptional `h` mapping to
U+210E, an already-supplementary mathematical scalar, `mathvariant="normal"`,
CSS italic, and a scripted token. The capture now records computed
`textTransform`, and applies mathematical-italic substitution only when Blink
reports `math-auto`; this keeps the normal-variant control as ASCII.

The scripted discriminator uses WPT's generated
`largeop-displayoperatorminheight2000-2AFF-italiccorrection3000.woff`. Its
display-size U+2AFF variant has a deliberately nonzero MATH italic correction.
In an `msubsup`, Blink subtracts that value from the subscript position while
leaving the superscript at the post-base origin, proving the correction branch
actually ran. The bundled base64 fixture is the upstream 1,372-byte WOFF, not
a raster-derived calibration.

Terminal glyph masks are intentionally outside this oracle. They remain
platform-native raster evidence; the logical contract ends at exact face,
glyph, metrics, offsets, Range geometry and baseline.

Source authority is Chromium `7d859f271c`, especially `mathml.css`'s
`math-auto` rule and `math_scripts_layout_algorithm.cc:326-389`, plus WPT's
generated MATH font named above.
