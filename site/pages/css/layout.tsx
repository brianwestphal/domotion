/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "css/layout",
  title: "Layout",
  subtitle: "Display modes, positioning, overflow — everything Chromium laid out gets captured.",
};

export const content: SafeHtml = raw(`
<p>Domotion captures the laid-out box positions Chromium computed — it doesn't
re-implement layout. That means anything that affects where boxes <em>land</em>
(<code>flex</code>, <code>grid</code>, <code>float</code>, <code>position</code>,
<code>display: block</code> / <code>inline</code> / <code>inline-block</code> /
<code>table</code> / <code>contents</code> / <code>none</code>, the full margin
/ padding / sizing model, logical properties, <code>border-collapse</code>) is
implicitly supported because the captured coordinates already reflect the
resolved layout.</p>

<p>Floats and clears work because text wrap is captured per visual line —
Chromium has already done the line-breaking around the float, and the resulting
line boxes are what Domotion records. Lists work end-to-end:
<code>list-style-type</code> markers (disc / circle / square / decimal /
lower-alpha / lower-roman / etc.) are synthesized as shapes or text,
<code>list-style-image: url(...)</code> renders as an
<code>&lt;image&gt;</code> at the marker slot, <code>list-style-position</code>
is honored, and <code>::marker</code> styling (color, font-weight, font-size)
flows through.</p>

<h2>The exceptions</h2>

<ul>
  <li><strong><code>position: fixed</code> and <code>sticky</code></strong> —
    paint order is correct, but the element renders at the captured position
    with no scroll-following. The SVG output is one static frame, so there's
    nothing for it to follow.</li>
  <li><strong><code>overflow: scroll</code> and <code>auto</code></strong> —
    content is clipped to the visible region and the captured
    <code>scrollTop</code> is honored, but the native scrollbar chrome isn't
    yet emulated. The visible scroll region renders correctly.</li>
  <li><strong>Nested stacking contexts</strong> — a child with <code>z-index</code>
    that's "trapped" inside an opacity / transform stacking context may paint
    above an outside sibling that should logically be on top. Sibling
    <code>z-index</code> at the same stacking level always paints in the right
    order.</li>
</ul>

<p><code>overflow: hidden</code> / <code>clip</code> / <code>visible</code> and
<code>overflow-clip-margin</code> all work — children are clipped to the
padding box via SVG <code>&lt;clipPath&gt;</code> when needed.</p>
`);
