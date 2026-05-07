/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "api/captured-element",
  title: "CapturedElement",
  subtitle: "The shape of every node in a captured tree.",
};

export const content: SafeHtml = raw(`
<p>The intermediate representation between
<a href="../capture-element-tree/"><code>captureElementTree()</code></a>
and <a href="../element-tree-to-svg/"><code>elementTreeToSvg()</code></a>.
A plain serialisable object — JSON-roundtrip safe — so you can cache it,
diff it, or transform it before render.</p>

<div class="callout note">
  <span class="icon">ⓘ</span>
  <div class="body">
    <p>Domotion is at <code>0.x</code>; new fields are added under
    <code>styles</code> as new CSS support lands. Treat
    <code>CapturedElement</code> as <em>open</em> — read what you need, ignore
    the rest, never assume the field set is exhaustive.</p>
  </div>
</div>

<h2>Core fields</h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">CapturedElement</span> {
  tag: <span class="tk-t">string</span>;
  text: <span class="tk-t">string</span>;
  x: <span class="tk-t">number</span>;
  y: <span class="tk-t">number</span>;
  width: <span class="tk-t">number</span>;
  height: <span class="tk-t">number</span>;
  styles: <span class="tk-t">CapturedStyles</span>;
  children: <span class="tk-t">CapturedElement</span>[];
  textSegments?: <span class="tk-t">TextSegment</span>[];
  <span class="tk-c">// ...form-control / raster-fallback fields</span>
}</pre>

<div class="params">
  <div class="row">
    <div class="name">tag</div>
    <div class="type">string</div>
    <div class="desc">Lowercase HTML tag name. <code>"div"</code>, <code>"span"</code>, <code>"input"</code>, etc.</div>
  </div>
  <div class="row">
    <div class="name">text</div>
    <div class="type">string</div>
    <div class="desc">Concatenated text content, used as a fallback when <code>textSegments</code> isn't available.</div>
  </div>
  <div class="row">
    <div class="name">x, y</div>
    <div class="type">number</div>
    <div class="desc">Top-left corner relative to the capture viewport, in CSS pixels.</div>
  </div>
  <div class="row">
    <div class="name">width, height</div>
    <div class="type">number</div>
    <div class="desc">Box dimensions in CSS pixels. Includes border but not margin (matches Chromium's <code>getBoundingClientRect</code>).</div>
  </div>
  <div class="row">
    <div class="name">styles</div>
    <div class="type">CapturedStyles</div>
    <div class="desc">~80 captured computed-style fields: backgrounds, borders, fonts, decorations, transforms, gradients, etc. See below.</div>
  </div>
  <div class="row">
    <div class="name">children</div>
    <div class="type">CapturedElement[]</div>
    <div class="desc">Captured descendants in paint order.</div>
  </div>
  <div class="row">
    <div class="name">textSegments?</div>
    <div class="type">TextSegment[]</div>
    <div class="desc">Per-line / per-styled-run text data with viewport-relative position and per-character x offsets.</div>
  </div>
</div>

<h2>The <code>styles</code> object</h2>

<p>Domotion captures a curated set of computed styles — enough to faithfully
reproduce the element in SVG. Highlights, grouped:</p>

<h3>Backgrounds &amp; layout</h3>
<ul>
  <li><code>backgroundColor</code>, <code>backgroundImage</code>,
    <code>backgroundSize</code>, <code>backgroundPosition</code>,
    <code>backgroundRepeat</code>, <code>backgroundClip</code>,
    <code>backgroundOrigin</code>, <code>backgroundAttachment</code>.</li>
  <li><code>paddingTop/Right/Bottom/Left</code>.</li>
  <li><code>opacity</code>, <code>zIndex</code>, <code>position</code>,
    <code>float</code>.</li>
  <li><code>overflowX</code>, <code>overflowY</code>, <code>scrollbarGutter</code>,
    <code>scroll{Width,Height,Top,Left}</code>, <code>client{Width,Height}</code>.</li>
</ul>

<h3>Borders</h3>
<ul>
  <li>Per-side: <code>borderTop/Right/Bottom/Left{Width,Style,Color}</code>.</li>
  <li>Per-corner: <code>borderTopLeftRadius</code>,
    <code>borderTopRightRadius</code>,
    <code>borderBottomRightRadius</code>,
    <code>borderBottomLeftRadius</code>.</li>
  <li>Border-image: <code>borderImageSource</code>, <code>borderImageSlice</code>,
    <code>borderImageWidth</code>, <code>borderImageOutset</code>,
    <code>borderImageRepeat</code>.</li>
</ul>

<h3>Text &amp; decorations</h3>
<ul>
  <li><code>color</code>, <code>fontFamily</code>, <code>fontSize</code>,
    <code>fontWeight</code>, <code>fontStyle</code>, <code>letterSpacing</code>,
    <code>textAlign</code>, <code>textDecoration*</code>.</li>
</ul>

<h3>Transform / filters / masks</h3>
<ul>
  <li><code>filter</code>, <code>backdropFilter</code>, <code>mixBlendMode</code>.</li>
  <li><code>clipPath</code>, <code>mask</code>, <code>maskImage</code>,
    <code>maskMode</code>, <code>maskSize</code>, <code>maskPosition</code>,
    <code>maskRepeat</code>, <code>maskComposite</code>.</li>
</ul>

<h3>Form controls</h3>
<ul>
  <li><code>inputType</code>, <code>checked</code>, <code>indeterminate</code>,
    <code>disabled</code>.</li>
  <li><code>progressValue</code>, <code>progressMax</code>, plus author-styled
    pseudo overrides (<code>progressBarBg</code>, <code>progressBarRadius</code>,
    etc.).</li>
</ul>

<h2><code>TextSegment</code></h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">TextSegment</span> {
  text: <span class="tk-t">string</span>;
  x: <span class="tk-t">number</span>; y: <span class="tk-t">number</span>;
  width: <span class="tk-t">number</span>; height: <span class="tk-t">number</span>;
  xOffsets?: <span class="tk-t">number</span>[];
  color?: <span class="tk-t">string</span>;
  fontSize?: <span class="tk-t">number</span>;
  fontWeight?: <span class="tk-t">string</span>;
  rasterRect?: { x; y; width; height };
  rasterDataUri?: <span class="tk-t">string</span>;
  rasterGlyphs?: { charIndex; rect; dataUri? }[];
}</pre>

<p>The key field is <code>xOffsets</code>: an array of viewport-relative
x positions, one per visible character. Renderers anchor each glyph at
<code>xOffsets[i]</code> rather than summing fontkit advances, so captured
text matches Chromium's sub-pixel positioning. See
<a href="../../concepts/text-rendering/">Text rendering</a>.</p>

<h2>Raster fall-back fields</h2>

<p>When a region can't be expressed as SVG primitives, the capture script
records a clip rect and the post-capture rasteriser fills in a base64 PNG
data URI:</p>

<ul>
  <li><strong>Element-level:</strong> <code>elementRaster</code> on the element
    (e.g. textarea content too involved to word-wrap).</li>
  <li><strong>Segment-level:</strong> <code>rasterRect</code> +
    <code>rasterDataUri</code> on a text segment whose entire content is a
    color-bitmap run.</li>
  <li><strong>Per-character:</strong> <code>rasterGlyphs</code> for emoji /
    color-bitmap codepoints mixed into otherwise path-rendered text.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../../concepts/element-tree/">The element tree</a> — design overview.</li>
  <li><a href="../capture-element-tree/"><code>captureElementTree()</code></a> — produces it.</li>
  <li><a href="../element-tree-to-svg/"><code>elementTreeToSvg()</code></a> — consumes it.</li>
</ul>
`);
