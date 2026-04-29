/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/borders",
  title: "Borders & radius",
  subtitle: "Per-side borders, all border-styles, rounded and pill shapes — with a couple of caveats.",
};

export const content: SafeHtml = raw(`
<figure style="margin:0 0 24px;">
  <img src="../../assets/img/borders-gallery.svg" alt="Eight-tile gallery showing solid, dashed, dotted, groove, pill, squircle, asymmetric and inset borders." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="margin-top:8px;font-size:13px;color:var(--fg-muted);">Border styles and corner shapes captured live by Domotion.</figcaption>
</figure>

<p>Borders, outlines, corner radii, and shadows all round-trip faithfully. Per-side
widths, per-corner radii (including elliptical), every <code>border-style</code>
keyword, multi-layer outset and inset shadows, and stacked text-shadows
(the "neon glow" pattern) all work. The exceptions:</p>

<ul>
  <li><code>border-image</code> — not yet implemented.</li>
  <li><strong>Very large blur values</strong> (≥ 50&nbsp;px) on small boxes may be
    slightly cropped at the edges. SVG filter regions clip to a bounding box
    that's ~3× the blur radius; bump the surrounding container if you see this.</li>
</ul>

<h2>How it's wired up</h2>

<p>Each shadow becomes a <code>&lt;rect&gt;</code> rendered through an SVG
<code>&lt;filter&gt;</code> with <code>feGaussianBlur</code>, layered behind
(outset) or in front of (inset) the element. Spread is implemented as an
outset / inset of the rect dimensions before blurring.</p>

<p>Border-radius percentages (<code>50%</code> on a square box → circle) work
because Domotion reads the resolved per-corner longhand values, which Chromium
has already converted to pixel radii. Mixed-style per-side borders (e.g.
solid bottom + dashed top) render each side independently with the correct
corner joins.</p>

<p>Text shadows use the same primitives as box-shadow but applied to the
rendered text; multi-layer text shadows produce one filter pass per layer.</p>
`);
