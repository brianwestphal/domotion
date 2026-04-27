export const meta = {
  slug: "css/transforms",
  title: "Transforms",
  subtitle: "translate works; rotate / scale / skew currently render as bounding box.",
};

export const content = `
<p>This is the area where Domotion has the largest known gap. Today, only
translation is faithfully reproduced; rotation, scale, skew, and matrix
transforms are captured but rendered as the un-transformed bounding box of
the element. The doc <code>docs/28-css-transforms.md</code> in the source tree
tracks this work.</p>

<h2>Support matrix</h2>

<table>
  <thead><tr><th>Transform</th><th>Status</th><th>Notes</th></tr></thead>
  <tbody>
    <tr>
      <td><code>transform: translate(x, y)</code></td>
      <td>Partial</td>
      <td>The bounding box absorbs the translation — the element renders at its visually-translated position. Works because Domotion captures the resolved <code>getBoundingClientRect</code>.</td>
    </tr>
    <tr>
      <td><code>transform: translateX / translateY / translate3d</code></td>
      <td>Partial</td>
      <td>Same as <code>translate</code> for the 2D component; z is ignored.</td>
    </tr>
    <tr>
      <td><code>transform: rotate(...)</code></td>
      <td>None</td>
      <td>Renders as the element's axis-aligned bounding box at the rotated position. Visually wrong for any non-trivial rotation. Warning logged.</td>
    </tr>
    <tr>
      <td><code>transform: scale(...)</code></td>
      <td>None</td>
      <td>Renders as the post-scale bounding box, but inner content is captured at original size — proportions look wrong.</td>
    </tr>
    <tr>
      <td><code>transform: skew(...) / matrix(...)</code></td>
      <td>None</td>
      <td>Same.</td>
    </tr>
    <tr>
      <td>3D transforms (<code>perspective</code>, <code>rotate3d</code>, etc.)</td>
      <td>None</td>
      <td>Out of scope; degraded to the underlying 2D component (which is itself unsupported).</td>
    </tr>
  </tbody>
</table>

<h2>Workarounds</h2>

<p>If your demo needs a rotated or scaled element today, you have three
options:</p>

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
reproducing a rotated text run in SVG requires either applying a
matched <code>transform</code> on the path elements (loses hinting parity)
or rasterising the rotated region (loses vector benefits). Both paths are
on the roadmap; neither is shipped yet.</p>

<p>Translation, by contrast, doesn't change glyph orientation — Chromium's
rendering is the same as if the box were positioned absolutely, which the
captured bounding box already absorbs.</p>

<h2>See also</h2>

<ul>
  <li><code>docs/28-css-transforms.md</code> in the repo for the design notes
    on what a full transform implementation will look like.</li>
</ul>
`;
