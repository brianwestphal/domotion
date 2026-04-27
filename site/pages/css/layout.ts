export const meta = {
  slug: "css/layout",
  title: "Layout",
  subtitle: "Display modes, flow, positioning, overflow.",
};

export const content = `
<p>Domotion captures the laid-out box positions Chromium computed — it doesn't
re-implement layout. That means anything that affects where boxes <em>land</em>
(flex, grid, floats, positioning) is implicitly supported because the
captured coordinates already reflect the resolved layout.</p>

<h2>Display modes</h2>

<table>
  <thead><tr><th>Display</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>block</code> / <code>inline</code> / <code>inline-block</code></td><td>Full</td></tr>
    <tr><td><code>flex</code> / <code>inline-flex</code></td><td>Full — captured at resolved positions.</td></tr>
    <tr><td><code>grid</code> / <code>inline-grid</code></td><td>Full</td></tr>
    <tr><td><code>table</code> / <code>table-row</code> / <code>table-cell</code></td><td>Full — including <code>border-collapse</code> and <code>empty-cells: hide</code>.</td></tr>
    <tr><td><code>contents</code></td><td>Full — children are captured directly.</td></tr>
    <tr><td><code>none</code></td><td>Full — element skipped.</td></tr>
  </tbody>
</table>

<h2>Box model</h2>

<table>
  <thead><tr><th>Property</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>box-sizing: content-box / border-box</code></td><td>Full — captured dimensions are absolute and already correct.</td></tr>
    <tr><td><code>margin</code> (all variants)</td><td>Full — affects layout, captured positions reflect it.</td></tr>
    <tr><td><code>padding</code></td><td>Full — captured per side; affects child positioning and background-clip.</td></tr>
    <tr><td><code>width</code> / <code>height</code> / <code>min-*</code> / <code>max-*</code></td><td>Full</td></tr>
    <tr><td>Logical properties (<code>inline-size</code>, <code>block-size</code>, <code>padding-block</code>, etc.)</td><td>Full — Chromium resolves them to physical, Domotion captures the physical computed values.</td></tr>
  </tbody>
</table>

<h2>Positioning</h2>

<table>
  <thead><tr><th>Position</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>static</code> / <code>relative</code> / <code>absolute</code></td><td>Full</td></tr>
    <tr><td><code>fixed</code></td><td>Partial — paint order correct, rendered at the captured position. No scroll-following animation since the SVG is a static frame.</td></tr>
    <tr><td><code>sticky</code></td><td>Partial — same as fixed.</td></tr>
  </tbody>
</table>

<h2>Float and clear</h2>

<p>Floats work fully because text wrap is captured per visual line — Chromium
has already done the line-breaking around the float, and the resulting line
boxes are what Domotion records.</p>

<h2>Overflow</h2>

<table>
  <thead><tr><th>Mode</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>overflow: hidden / clip</code></td><td>Full — children are clipped to the padding box via SVG <code>&lt;clipPath&gt;</code>.</td></tr>
    <tr><td><code>overflow: visible</code></td><td>Full — children may extend past the box.</td></tr>
    <tr><td><code>overflow: scroll / auto</code></td><td>Partial — content is clipped and the captured <code>scrollTop</code> is honoured, but the native scrollbar chrome isn't yet emulated. The visible scrollable region renders correctly.</td></tr>
    <tr><td><code>overflow-clip-margin</code></td><td>Full</td></tr>
  </tbody>
</table>

<h2>Stacking</h2>

<ul>
  <li><strong>Sibling z-index</strong> — paint order respects z-index. Negative
    z-indexes paint behind, base elements next, then auto/0, then positive in
    order.</li>
  <li><strong>Nested stacking contexts</strong> — partial. A child with z-index
    that's "trapped" inside an opacity / transform stacking context may paint
    above an outside sibling that should logically be on top.</li>
</ul>

<h2>Lists</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>list-style-type: disc / circle / square / decimal / lower-alpha / lower-roman</code> etc.</td><td>Full — markers synthesised as shapes or text.</td></tr>
    <tr><td><code>list-style-image: url(...)</code></td><td>Full — rendered as <code>&lt;image&gt;</code> at the marker slot.</td></tr>
    <tr><td><code>list-style-position: inside / outside</code></td><td>Full</td></tr>
    <tr><td><code>::marker</code> styling (color, font-weight, font-size)</td><td>Full</td></tr>
  </tbody>
</table>
`;
