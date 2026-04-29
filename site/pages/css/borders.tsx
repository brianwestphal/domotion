/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/borders",
  title: "Borders & radius",
  subtitle: "Per-side borders, all border-styles, rounded and pill shapes.",
};

export const content: SafeHtml = raw(`
<figure style="margin:0 0 24px;">
  <img src="../../assets/img/borders-gallery.svg" alt="Eight-tile gallery showing solid, dashed, dotted, groove, pill, squircle, asymmetric and inset borders." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="margin-top:8px;font-size:13px;color:var(--fg-muted);">Border styles and corner shapes captured live by Domotion.</figcaption>
</figure>

<h2>Border properties</h2>

<table>
  <thead><tr><th>Property</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>Uniform <code>border</code> (same on all sides)</td><td>Full</td></tr>
    <tr><td>Per-side <code>border-{top,right,bottom,left}</code> with different widths / styles / colours</td><td>Full</td></tr>
    <tr><td><code>border-radius</code> shorthand and per-corner longhands</td><td>Full</td></tr>
    <tr><td><code>border-radius: 50%</code> on a square box</td><td>Full — output is a circle, not a 50px corner.</td></tr>
    <tr><td><code>border-radius</code> with elliptical corners (<code>30px / 15px</code>)</td><td>Full</td></tr>
    <tr><td><code>border-image</code></td><td>None — tracked feature, not yet implemented.</td></tr>
  </tbody>
</table>

<h2>Border styles</h2>

<table>
  <thead><tr><th>Style</th><th>Status</th><th>Notes</th></tr></thead>
  <tbody>
    <tr><td><code>solid</code></td><td>Full</td><td></td></tr>
    <tr><td><code>dashed</code></td><td>Full</td><td>Dash pattern matches Chromium's heuristic (length scales with width).</td></tr>
    <tr><td><code>dotted</code></td><td>Full</td><td>Round dots, spacing matches Chromium.</td></tr>
    <tr><td><code>double</code></td><td>Full</td><td>Two parallel strokes with the gap that Chromium computes.</td></tr>
    <tr><td><code>groove / ridge / inset / outset</code></td><td>Full</td><td>3D effect via per-side colour shading; matches Chromium for solid backgrounds.</td></tr>
    <tr><td><code>none / hidden</code></td><td>Full</td><td>Border not painted.</td></tr>
  </tbody>
</table>

<h2>Outline</h2>

<p><code>outline</code> works the same as borders but without affecting layout
— style, width, colour, and offset are all honoured, including dashed and
dotted outlines.</p>

<h2>Box shadow</h2>

<table>
  <thead><tr><th>Variant</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>Outset shadow with x/y offset, blur, spread</td><td>Full</td></tr>
    <tr><td>Inset shadow</td><td>Full</td></tr>
    <tr><td>Multiple stacked shadows</td><td>Full</td></tr>
    <tr><td>Coloured shadows (any CSS colour)</td><td>Full</td></tr>
  </tbody>
</table>

<p>Implementation: each shadow is a <code>&lt;rect&gt;</code> rendered through
an SVG <code>&lt;filter&gt;</code> with <code>feGaussianBlur</code>, layered
behind (outset) or in front of (inset) the element. Spread is implemented as
an outset / inset of the rect dimensions before blurring.</p>

<h2>Text shadow</h2>

<p>Same primitives as box-shadow, but applied to the rendered text. Multi-layer
text shadows (the "neon glow" pattern) work — each layer becomes its own
filter pass.</p>

<h2>Common pitfalls</h2>

<ul>
  <li><strong>Border-radius percentages</strong> — Chromium resolves them to
    pixel radii in the longhand corner properties. Domotion reads the longhand,
    so percentages always work even though the shorthand
    <code>border-radius</code> string contains a literal percentage.</li>
  <li><strong>Mixed-style per-side borders</strong> — for example a solid
    bottom border and a dashed top border. Each side is rendered independently
    with the right corners.</li>
  <li><strong>Very large blur values</strong> — SVG filter regions are clipped
    to a bounding box that's ~3× the blur radius; box shadows with very large
    blur (≥ 50px) on small boxes may be slightly cropped at the edges. Bump
    the surrounding container if you see this.</li>
</ul>
`);
