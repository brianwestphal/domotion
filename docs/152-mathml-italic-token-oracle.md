# MathML italic-token logical oracle

Status: **Shipped (DM-2441), source-boundary repair shipped (DM-2511)**

`npm run fonts:mathml-italic` is a browser-backed logical oracle for MathML
`<mi>` transformation and shaping. Each row joins the original DOM scalar to
Chromium's computed `text-transform`, the captured scalar, Range and token
geometry, CDP's one painted face/cut, the selected source file SHA and face
index, glyph id, UTF-16/code-point span, HarfBuzz cluster, advance and offsets,
source-outline identity, and the final captured baseline.

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

## Terminal ownership and anti-vacuity

DM-2511 removes the oracle's former assumption that paths mode must record one
paths run. A captured token is first rendered unchanged through
`elementTreeToSvgInner`. The production provenance stream must contain markup,
at least one transition, and exactly one final owner. `capture-raster` is now an
explicit transition for a transform-subtree, text-segment, or legacy element
raster; `source-owned-boundary` and `paths-succeeded` are the other paths-mode
terminal classifications. A zero-run raster is therefore classified evidence,
not an empty success.

Selection evidence is collected separately before that terminal. The oracle
clones the same captured token, removes only capture-owned text-raster metadata,
and sends the clone through the same production paths renderer. It requires one
selected run and joins that run to CDP before accepting the captured terminal.
This probe does not change production ownership and does not substitute a
second shaping implementation.

The canonical `mathml-mi-greek-italic` fixture supplies the α, β, π, and θ
rows. Helper-enabled and `DOMOTION_DISABLE_HELPER=1` arms invalidate the font
environment caches between runs. At least one production route identifier must
be present in each arm, helper availability must change from true to false, and
transformed scalars, final terminal classification, physical source/face, gid,
clusters, advances, offsets, and outline identity must remain exact. Linux can
legitimately select the same FreeSans route without the helper because
Fontconfig exposes the same physical source directly. Those four live records
also pass DM-2512's pure authenticated Noble FreeSans token validator. This is
an active negative control, not a helper-disabled duplicate that can pass
vacuously.

Terminal glyph masks remain intentionally outside this oracle. They are owned
by the authenticated paths/native-raster floor in doc 210; neither DM-2511 nor
DM-2512 changes a scalar visual tolerance.

Source authority is Chromium `7d859f271c`, especially `mathml.css`'s
`math-auto` rule, `computed_style.cc:1941-1974`'s single-UTF-16-unit transform,
`shape_result.cc:1526-1557`'s consumption of HarfBuzz gid/cluster/position
records, and `math_scripts_layout_algorithm.cc:326-389`, plus HarfBuzz
`4de187dd0` and WPT's generated MATH font named above. Skia `62efacd3` owns the
post-selection native mask/vector-path terminal split described in docs 197,
203, and 210.
