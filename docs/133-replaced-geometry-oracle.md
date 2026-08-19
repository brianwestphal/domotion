# 133 — Replaced elements, controls, and generated-content geometry oracle

`npm run replaced:geometry-oracle` is the live-Chromium decision gate for the
geometry and ownership transitions that do not belong to ordinary CSS box
painting.

The object-fit leg paints an 80×40 intrinsic image into a 200×120 content box
and observes the colored pixel bounds in Chromium. All five sizing modes
(`fill`, `contain`, `cover`, `none`, and `scale-down`) are compared with
`computeObjectFitRect()`, including non-min/mid/max percentages and computed
`calc()` positions. This follows Blink's
`LayoutReplaced::ComputeObjectFitAndPositionRect`: choose the concrete object
size, resolve each position axis against the remaining free space, then clip
paint to the content box. Domotion emits that concrete rectangle directly;
SVG `preserveAspectRatio` is no longer used as a three-bucket approximation
when intrinsic dimensions are available.

The control leg captures live native and author-owned controls. Chromium's
native `appearance` surface must activate `nativeControlRaster`, while
`appearance:none` and an author-painted button must remain on the vector path.
The generated-content leg compares the painted pixel bounds of positioned
`::before` and `::after` boxes with the capture walker's `pseudoBoxes` records.

The 11-row gate has a mutation control that changes object-position and
requires the concrete rectangle to move. Pixel fixtures remain responsible
for final compositing, platform theme pixels, generated glyph outlines, and
the deliberately frozen contents of dynamic replaced surfaces.
