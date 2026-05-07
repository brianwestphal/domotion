/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "css/transforms",
  title: "Transforms",
  subtitle: "translate works; rotate / scale / skew currently render as bounding box.",
};

export const content: SafeHtml = raw(`
<p>This is currently the largest fidelity gap in Domotion. Only translation
round-trips faithfully — every other CSS transform is captured but rendered
as the un-transformed axis-aligned bounding box of the element.</p>

<h2>What works</h2>

<ul>
  <li><strong><code>transform: translate(x, y)</code></strong>,
    <code>translateX</code>, <code>translateY</code>, the 2D component of
    <code>translate3d</code> — the bounding box absorbs the translation, so
    the element renders at its visually-translated position. (Domotion captures
    the resolved <code>getBoundingClientRect</code>, which Chromium has already
    moved.)</li>
</ul>

<h2>What doesn't</h2>

<ul>
  <li><strong><code>rotate</code></strong> — renders as the element's
    axis-aligned bounding box at the rotated position. Visually wrong for any
    non-trivial rotation. Warning logged.</li>
  <li><strong><code>scale</code></strong> — renders as the post-scale bounding
    box, but inner content is captured at original size, so proportions look
    wrong.</li>
  <li><strong><code>skew</code> and <code>matrix</code></strong> — same as
    rotate.</li>
  <li><strong>3D transforms</strong> (<code>perspective</code>,
    <code>rotate3d</code>, etc.) — out of scope; degraded to the underlying
    2D component (which is itself unsupported).</li>
</ul>

<h2>Workarounds</h2>

<p>If your demo needs a rotated or scaled element today:</p>

<ol>
  <li><strong>Pre-bake the rotation into your HTML.</strong> Use an SVG icon
    rotated in its own coordinates rather than a CSS-rotated DOM element.
    SVG content under <code>&lt;svg&gt;</code> elements is passed through verbatim.</li>
  <li><strong>Capture the post-transform layout from a screenshot.</strong>
    Use Playwright's <code>page.screenshot({ clip })</code> on the element
    and embed the PNG as an <code>&lt;image&gt;</code>. You lose vector
    fidelity but the visual is correct.</li>
  <li><strong>Author rotation in SVG markup directly.</strong> If the rotated
    region is small (an icon, a badge), inline the SVG markup in the HTML
    and let it pass through.</li>
</ol>

<h2>Why this is hard</h2>

<p>Rotated text isn't just "draw the same characters at an angle" — Chromium
hints glyphs differently when their baseline isn't axis-aligned, the
sub-pixel positioning rules change, and decoration metrics shift. Faithfully
reproducing a rotated text run in SVG requires either applying a matched
<code>transform</code> on the path elements (loses hinting parity) or
rasterising the rotated region (loses vector benefits). Both paths are on
the roadmap; neither is shipped yet.</p>

<p>Translation, by contrast, doesn't change glyph orientation — Chromium's
rendering is the same as if the box were positioned absolutely, which the
captured bounding box already absorbs.</p>

<h2>See also</h2>

<ul>
  <li><code>docs/06-css-transforms.md</code> in the repo for the design notes
    on what a full transform implementation will look like.</li>
</ul>
`);
