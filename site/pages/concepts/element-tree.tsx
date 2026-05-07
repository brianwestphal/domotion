/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "concepts/element-tree",
  title: "The element tree",
  subtitle: "The intermediate representation that connects capture to render.",
};

export const content: SafeHtml = raw(`
<p>Domotion's middle layer is a <code>CapturedElement[]</code> — a recursive
tree of plain objects that mirrors the captured DOM subtree. Knowing its
shape is useful when you need to <em>diff captures</em>, <em>cache them</em>,
or <em>transform them between capture and render</em>.</p>

<h2>The shape, in one minute</h2>

<pre><code><span class="tk-k">interface</span> <span class="tk-t">CapturedElement</span> {
  tag: <span class="tk-t">string</span>;                              <span class="tk-c">// "div", "span", "input", ...</span>
  text: <span class="tk-t">string</span>;                             <span class="tk-c">// concatenated text content</span>
  x: <span class="tk-t">number</span>; y: <span class="tk-t">number</span>;                       <span class="tk-c">// viewport-relative top-left</span>
  width: <span class="tk-t">number</span>; height: <span class="tk-t">number</span>;
  styles: { <span class="tk-c">/* ~80 computed-style fields */</span> };
  children: <span class="tk-t">CapturedElement</span>[];
  textSegments?: <span class="tk-t">TextSegment</span>[];                <span class="tk-c">// per-line/per-run text data</span>
  <span class="tk-c">// ...plus form-control and raster-fallback fields</span>
}</code></pre>

<p>The full type lives in <a href="../../api/captured-element/"><code>CapturedElement</code></a>;
this page focuses on the design, not every field.</p>

<h2>Why a tree, not a flat list</h2>

<p>SVG is hierarchical: a child group inherits its parent's transform,
clip, and opacity. Keeping the captured representation hierarchical means
the renderer can emit a <code>&lt;g transform="..."&gt;</code> wrapper once
per parent and let SVG semantics propagate the rest. A flat list would mean
re-applying every ancestor's clip path and transform on every leaf.</p>

<h2>Why coordinates are viewport-relative</h2>

<p>All <code>x</code> / <code>y</code> values in the tree are relative to the
capture viewport, not the document. That makes the tree directly composable
with <code>elementTreeToSvg(tree, width, height)</code> — the SVG starts at
(0,&nbsp;0) and matches the dimensions you pass.</p>

<p>If you capture a subtree that's offset within the viewport, that offset
is preserved. To "snap to top-left" instead, pass the element's bounding
box as the viewport rect (see <a href="../../start/first-capture/">Your
first capture</a>).</p>

<h2>Text segments</h2>

<p>Text-bearing elements have an optional <code>textSegments</code> array.
Each segment represents one line (for multi-line text) or one same-styling
run (for mixed inline content like <code>&lt;span style="color:red"&gt;</code>
inside a paragraph). Segments carry:</p>

<ul>
  <li>The text string and its bounding box.</li>
  <li>An optional <strong>per-character x-offset array</strong>
    — the viewport-absolute x for each visible character. The renderer
    anchors each glyph at <code>xOffsets[i]</code> instead of summing
    fontkit advances, which keeps captured text pixel-aligned with what
    Chromium painted (Chromium uses sub-pixel positioning that accumulates
    drift if you re-shape from advances).</li>
  <li>Optional per-segment color / size / weight overrides for pseudos
    like <code>::before</code> and <code>::after</code>.</li>
</ul>

<h2>Form controls</h2>

<p><code>&lt;input&gt;</code>, <code>&lt;progress&gt;</code>,
<code>&lt;meter&gt;</code> and friends carry extra fields:
<code>inputType</code>, <code>checked</code>, <code>indeterminate</code>,
<code>disabled</code>, <code>progressValue</code>, etc. The renderer uses
those to synthesise the SVG markup that mimics Chromium's user-agent
shadow DOM. See <a href="../../css/form-controls/">Form controls</a>.</p>

<h2>Raster fall-back fields</h2>

<p>For pieces that can't be expressed in SVG primitives, the capture script
records a clip rectangle on the segment or element, and the post-capture
rasteriser fills in a <code>dataUri</code> field with the corresponding
PNG. The renderer emits an <code>&lt;image&gt;</code> for those regions and
skips the normal text / box pipeline.</p>

<h2>Inspecting a tree</h2>

<p>The tree is plain JSON-serialisable data. To inspect it:</p>

<pre><code><span class="tk-k">import</span> { writeFileSync } <span class="tk-k">from</span> <span class="tk-s">"node:fs"</span>;
<span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, vp);
<span class="tk-f">writeFileSync</span>(<span class="tk-s">"tree.json"</span>, JSON.<span class="tk-f">stringify</span>(tree, <span class="tk-k">null</span>, <span class="tk-n">2</span>));</code></pre>

<p>Open <code>tree.json</code> alongside the rendered SVG and you can map
each element 1:1 between the two — useful when something looks wrong and
you need to know whether the bug is in capture or render.</p>

<h2>Mutating before render</h2>

<p>Because the tree is plain data, you can transform it. Some patterns:</p>

<ul>
  <li><strong>Strip an element.</strong> Walk the tree, splice the offending
    node out of its parent's <code>children</code>.</li>
  <li><strong>Replace text.</strong> Set <code>el.text</code> on the element
    and clear <code>el.textSegments</code> (the renderer will re-shape).</li>
  <li><strong>Tint a region.</strong> Change <code>el.styles.backgroundColor</code>
    or <code>el.styles.color</code>.</li>
  <li><strong>Translate a subtree.</strong> Add or modify
    <code>el.styles.transform</code> on the wrapping element.</li>
</ul>

<div class="callout warn">
  <span class="icon">⚠</span>
  <div class="body">
    <p>If you change <code>el.text</code> after capture, you lose the
    per-character <code>xOffsets</code> the capture script measured from
    Chromium. The renderer will fall back to fontkit advance widths —
    accurate enough for short labels, but text that should sub-pixel-align
    with adjacent elements may drift slightly.</p>
  </div>
</div>

<h2>Next</h2>
<p><a href="../text-rendering/">Text rendering</a> explains how the renderer
turns the <code>textSegments</code> on each element into SVG glyph paths.</p>
`);
