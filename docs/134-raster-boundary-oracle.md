# 134 — Raster-fallback activation and vector-boundary oracle

`npm run raster:boundary-oracle` proves that raster paint is activated only at
an inventoried SVG representation boundary, and that the paired representable
case remains vector. It is an ownership/classification gate; the pixels inside
each activated raster remain the responsibility of that feature's paint or
visual oracle.

The 27 live/predicate rows cover:

- color emoji versus ordinary outline text, including helper-disabled mode;
- canvas, inaccessible iframe, accessible recursive iframe, CSS sprite image
  replacement, and an ordinary vector background;
- the retired whole-element text raster (soft-wrapped textarea and vertical
  text must both remain vector);
- native appearance versus `appearance:none` controls;
- backdrop-filter versus ordinary filter;
- HTML URL-reference `feConvolveMatrix` versus an ordinary URL filter and a
  native-SVG convolution negative control;
- projective versus affine transforms;
- Color 4 / varying-alpha versus opaque-sRGB gradients;
- conic versus linear gradients; and
- Chromium's parse-rejected `mask-image: element()` dormant path.

Every live capture row checks the data-bearing field after Node post-processing,
not merely the presence of a flag, so a classifier that never reaches emission
cannot pass. The mutation control crosses opaque sRGB into OKLab and requires
the verdict to move. Add a positive and negative row here whenever a fallback
is introduced, retired, or changes ownership, and update
`docs/reference/raster-image-fallback-cases.md` in the same commit.
