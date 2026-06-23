/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "guides/demo-gallery",
  title: "Demo gallery",
  subtitle: "Copy-pasteable examples, simplest to fanciest — the source is the demo.",
};

// Demo sources live next to their build commands under site/scripts/demos/
// (single-capture) and examples/animate/ (animated). Read + escape them at
// build time so the displayed source can never drift from the files that
// actually produce the committed SVGs.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEMOS_DIR = resolve(HERE, "../../scripts/demos");
const ANIMATE_DIR = resolve(HERE, "../../../examples/animate");

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function file(rel: string): string {
  return esc(readFileSync(resolve(DEMOS_DIR, rel), "utf8").trim());
}

function animFile(rel: string): string {
  return esc(readFileSync(resolve(ANIMATE_DIR, rel), "utf8").trim());
}

/** One animated gallery entry: the looping SVG + its copyable JSON config. */
function animDemo(opts: { img: string; alt: string; configPath: string }): string {
  return `
<figure style="margin:0 0 12px;">
  <img src="../../assets/img/demos/${opts.img}" alt="${esc(opts.alt)}"
       style="width:100%;height:auto;border-radius:12px;border:1px solid var(--line);" />
</figure>

<details>
  <summary>animate config (JSON)</summary>
  <pre><code>${animFile(opts.configPath)}</code></pre>
</details>

<p>Render it (output is written next to the config):</p>

<pre><code>domotion animate ${opts.configPath}</code></pre>`;
}

/** One gallery entry: rendered SVG + copyable HTML + the command that built it. */
function demo(opts: {
  img: string;
  alt: string;
  htmlPath: string;
  cmdPath: string;
}): string {
  return `
<figure style="margin:0 0 12px;">
  <img src="../../assets/img/demos/${opts.img}" alt="${esc(opts.alt)}"
       style="width:100%;height:auto;border-radius:12px;border:1px solid var(--line);" />
</figure>

<details>
  <summary>HTML source</summary>
  <pre><code>${file(opts.htmlPath)}</code></pre>
</details>

<p>Capture it:</p>

<pre><code>${file(opts.cmdPath)}</code></pre>`;
}

export const content: SafeHtml = raw(`
<p>This gallery is a progressive set of examples — from a five-line single
capture to a fully animated marketing clip. Every demo is a self-contained
folder under <code>site/scripts/demos/</code> in the repo: the HTML source, the
exact command that builds it, and the committed SVG you see here. Copy the
source, run the command, ship the SVG.</p>

<p>The output of every example is one self-contained SVG — it drops straight
into an <code>&lt;img&gt;</code> and scales crisply at any size.</p>

<p>Looking for reusable, parameterized generators rather than one-off examples?
See the <a href="../templates/">Templates</a> page — a banner, a device mockup,
animated typography, or a looping background from a single command (and how to
publish your own).</p>

<h2>Tier 1 — single capture</h2>

<p>Static visuals produced by a single <code>domotion capture</code>. No config,
no animation — just rendered HTML frozen as a portable SVG.</p>

<h3>Hero card</h3>

<p>A gradient-filled logo tile with a drop shadow, a tight headline, and a
monospace command chip — the everyday "marketing card" ingredients in one
capture.</p>

${demo({
  img: "hero-card.svg",
  alt: "A dark card with a blue-to-purple gradient logo tile, a bold headline 'Pixel-faithful HTML, served as one SVG', a subhead, and a monospace npm install command.",
  htmlPath: "hero-card/hero-card.html",
  cmdPath: "hero-card/capture.sh",
})}

<h3>Pricing table</h3>

<p>A polished three-tier (Free / Pro / Enterprise) table with a highlighted
middle column, a gradient "Popular" badge, and check/cross feature rows. The
kind of static marketing visual people pay a monthly design-tool subscription
to make — captured crisp and infinitely scalable.</p>

${demo({
  img: "pricing-table.svg",
  alt: "A three-column pricing table on a dark background: Free at $0, a highlighted Pro tier at $20 with a Popular badge and gradient button, and a Custom Enterprise tier.",
  htmlPath: "pricing-table/pricing-table.html",
  cmdPath: "pricing-table/capture.sh",
})}

<h3>Code block</h3>

<p>A real <code>&lt;pre&gt;&lt;code&gt;</code> with hand-rolled
<code>&lt;span&gt;</code>-colored syntax tokens inside a window-chrome card.
The captured text is emitted as glyph paths, so it stays sharp at any zoom and
the document structure stays inspectable in the SVG — not flattened to a
raster.</p>

${demo({
  img: "code-block.svg",
  alt: "A dark editor-style card titled capture.ts showing a syntax-highlighted TypeScript snippet that imports and calls captureElementTree and elementTreeToSvg.",
  htmlPath: "code-block/code-block.html",
  cmdPath: "code-block/capture.sh",
})}

<h3>Phone-framed mobile screen</h3>

<p>A mobile-viewport capture presented inside device chrome — a rounded body,
a dynamic-island notch, and a home indicator. Capture the page at a mobile
viewport, then wrap it.</p>

${demo({
  img: "phone-screen.svg",
  alt: "A phone bezel with a notch and home indicator framing a captured mobile landing page for Domotion with a hero headline, two buttons, and three feature cards.",
  htmlPath: "phone-screen/mobile-screen.html",
  cmdPath: "phone-screen/capture.sh",
})}

<div class="note">
  <p><strong>Device chrome is hand-drawn, for now.</strong> There is no
  <code>--chrome phone</code> flag yet, so the bezel is composited by
  <code>build-phone-screen.ts</code>, which nests the captured SVG inside a
  hand-drawn frame. When a device-chrome flag lands, this collapses to a single
  <code>domotion capture … --chrome phone</code> line.</p>
</div>

<h2>Tier 2 — animated, simple</h2>

<p>A few frames stitched into one looping SVG with a transition between them.
Each demo is a <code>domotion animate</code> JSON config plus its HTML frames,
living under <code>examples/animate/</code> in the repo. Start with the
<a href="../animated-demo/">Build an animated demo</a> guide for the config
basics.</p>

<h3>Typing search</h3>

<p>A single captured frame with a <code>typing</code> overlay that types a query
into a docs-style search bar — the text is revealed character by character with
a blinking caret.</p>

${animDemo({
  img: "typing-search.svg",
  alt: "A dark docs search bar with a magnifying-glass icon and a Cmd-K hint; the query 'how to install' types itself into the field.",
  configPath: "typing-search/typing-search.json",
})}

<h3>Tab switcher</h3>

<p>Three frames driven entirely by <code>click</code> actions on a live page —
each frame clicks the next tab and captures the resulting panel — composited
with a crossfade. The page keeps its state between frames because each frame
<code>continue</code>s the previous one instead of reloading.</p>

${animDemo({
  img: "tab-switcher.svg",
  alt: "A tabbed card crossfading between Overview, Pricing, and Changelog panels as each tab is clicked in turn.",
  configPath: "tab-switcher/tab-switcher.json",
})}

<h3>Before / after refactor</h3>

<p>Two semantically-distinct HTML files — a verbose loop and its refactored
equivalent — with a <code>push-left</code> transition between them. Perfect for
a technical blog post showing a code transformation.</p>

${animDemo({
  img: "before-after-refactor.svg",
  alt: "A code card labeled Before (an 8-line imperative loop) sliding left to reveal an After card (a 4-line filter/reduce refactor).",
  configPath: "before-after-refactor/before-after-refactor.json",
})}

<div class="note">
  <p><strong>Why three frames for a two-file demo?</strong> The config repeats
  the "after" frame with a trailing <code>cut</code> so the punchline holds
  solid — a push-left frame that is <em>last</em> in the loop currently fades
  out. Once that's fixed upstream the config collapses to the natural two
  frames.</p>
</div>

<h2>Tier 3 — animated, fancy</h2>

<p>The marketing-video tier — multi-step flows, terminal chrome, real recorded
interactions, and scroll-throughs.</p>

<h3>Multi-step terminal onboarding</h3>

<p>Four terminal panes — clone, install, configure, run — each typed by a
<code>typing</code> overlay and revealed with a <code>push-left</code>
transition. The marketing-video demo.</p>

${animDemo({
  img: "terminal-onboarding.svg",
  alt: "A terminal window stepping through git clone, npm install, npm run setup, and npm run dev, each command typing itself in as the panes slide left.",
  configPath: "terminal-onboarding/terminal-onboarding.json",
})}

<h3>Form fill flow</h3>

<p>A signup form driven entirely by <code>actions</code> — click each field,
<code>fill</code> it, then click submit — recorded against the live page. The
password field masks as you'd expect, and the submit reveals a success
message.</p>

${animDemo({
  img: "form-fill.svg",
  alt: "A signup form filling in name, email, and a masked password field one at a time, then showing a green success message after the submit button is clicked.",
  configPath: "form-fill/form-fill.json",
})}

<h3>Scroll-through a long page</h3>

<p>One tall landing page captured at successive scroll positions via a
<code>scroll</code> block (<code>down:bottom/5s</code>) and composed into a
single scrolling SVG. The sticky nav stays pinned while the sections scroll
past.</p>

${animDemo({
  img: "scroll-landing.svg",
  alt: "A product landing page scrolling from its hero down through feature cards, a testimonial, and a call-to-action, with the nav bar staying fixed at the top.",
  configPath: "scroll-landing/scroll-landing.json",
})}

<p>For more runnable configs — crossfade, magic-move, SVG overlays, a social
feed scroll — browse <code>examples/animate/</code> in the repo. Each folder
ships its config, its HTML frames, and a committed golden SVG you can open in a
browser to watch loop.</p>
`);
