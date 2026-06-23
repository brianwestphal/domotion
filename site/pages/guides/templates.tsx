/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "guides/templates",
  title: "Templates",
  subtitle: "Parameterized generators that turn a few flags into a self-contained animated SVG — and how to publish your own.",
};

/** One gallery entry: the rendered template SVG + the command that produced it. */
function tpl(opts: { img: string; alt: string; cmd: string }): string {
  return `
<figure style="margin:0 0 12px;">
  <img src="../../assets/img/templates/${opts.img}" alt="${opts.alt.replace(/"/g, "&quot;")}"
       style="width:100%;height:auto;border-radius:12px;border:1px solid var(--line);" />
</figure>

<pre><code>${opts.cmd}</code></pre>`;
}

export const content: SafeHtml = raw(`
<p>A <strong>template</strong> is a parameterized generator: you hand it a few
parameters and it produces a complete, self-contained animated SVG. It's authored
in HTML/CSS and driven through the same capture/compose pipeline as everything
else, so the output reflows, re-themes, and uses real fonts — it isn't a baked
vector asset. The expensive "lay it out and synthesize the keyframes" work runs
once, at author time; the SVG just replays.</p>

<pre><code>npm install -g domotion-svg
domotion template lower-third --title "Ada Lovelace" --subtitle "First Programmer" -o banner.svg</code></pre>

<p>List what's available and inspect any template's parameters:</p>

<pre><code>domotion template list
domotion template lower-third --help</code></pre>

<h2>Built-in templates</h2>

<p>Four templates ship in the box. Each SVG below was produced by the command
under it — copy, tweak the flags, ship the result.</p>

<h3>lower-third — broadcast banner</h3>
<p>A title + subtitle + accent bar that slides and fades into the corner. The
classic text/typography template.</p>
${tpl({
  img: "lower-third-dark.svg",
  alt: "A dark broadcast lower-third banner reading Ada Lovelace, First Programmer, sliding up into the bottom-left corner with a cyan accent bar.",
  cmd: `domotion template lower-third \\
  --title "Ada Lovelace" --subtitle "First Programmer" \\
  --accent "#22d3ee" --theme dark -o lower-third.svg`,
})}

<h3>device-mockup — frame a captured page</h3>
<p>A <em>decorator</em>: it captures a URL or HTML file and wraps it in a phone,
browser, or app-window bezel.</p>
${tpl({
  img: "device-mockup-browser.svg",
  alt: "A web app screenshot framed inside a macOS-style browser window with traffic-light buttons and a URL bar.",
  cmd: `domotion template device-mockup \\
  --input ./app.html --device browser \\
  --label "acme.dev/dashboard" -o mockup.svg`,
})}

<h3>kinetic-text — animated typography</h3>
<p>A headline revealed word-by-word or character-by-character (rise / slide / fade
/ clip / pop), with multi-line + inline emphasis tags and a loop / boomerang mode.</p>
${tpl({
  img: "kinetic-text-pop.svg",
  alt: "The word POP! appearing one character at a time, each scaling up from its center with a springy overshoot.",
  cmd: `domotion template kinetic-text \\
  --text "POP!" --variant pop --by char --fontSize 200 -o title.svg`,
})}

<h3>background-loop — seamless animated backgrounds</h3>
<p>A procedurally-generated, seamlessly-looping background. Six variants: drifting
<code>aurora</code> / <code>orbs</code> blobs, a twinkling <code>stars</code>
field, a panning <code>gradient-pan</code> wash, a drifting <code>grid</code>, and
layered parallax <code>wave</code> ribbons. Deterministic from a <code>seed</code>.</p>
${tpl({
  img: "background-loop-wave.svg",
  alt: "Layered blue sine-wave ribbons stacked like an ocean, each panning horizontally at a different speed for a parallax effect.",
  cmd: `domotion template background-loop \\
  --variant wave --colors "#1e3a8a,#0891b2,#22d3ee,#67e8f9" -o bg.svg`,
})}
${tpl({
  img: "background-loop-aurora.svg",
  alt: "Large soft mesh-gradient colour blobs drifting and breathing over a deep navy background.",
  cmd: `domotion template background-loop --variant aurora -o aurora.svg`,
})}

<h2>Use a template inside an animation</h2>

<p>A template isn't only a one-shot CLI command — you can drop it into an
<code>animate</code> config as a <code>template</code> frame and compose it into a
larger multi-frame scene, right alongside captured pages and terminal recordings:</p>

<pre><code>{
  "width": 1280, "height": 720,
  "frames": [
    { "input": "intro.html", "duration": 1500, "transition": { "type": "crossfade", "duration": 300 } },
    { "template": "lower-third", "params": { "title": "Ada Lovelace", "subtitle": "First Programmer" } }
  ]
}</code></pre>

<p>The <code>params</code> are validated against the template's own schema, and the
frame inherits the template's play time when you omit <code>duration</code>.</p>

<h2>Find more — the <code>domotion-template-*</code> convention</h2>

<p>Templates are ordinary npm packages, so the npm registry <em>is</em> the
template registry. A package named <code>domotion-template-&lt;name&gt;</code> is
usable by its bare <code>&lt;name&gt;</code> the moment it's installed — no
registration, no config:</p>

<pre><code>npm install -g domotion-template-quote-card
domotion template quote-card --quote "Ship it." -o quote.svg</code></pre>

<p>Search npm for the <code>domotion-template</code> keyword (or the
<code>domotion-template-</code> name prefix) to discover community templates.</p>

<h2>Write your own</h2>

<p>Publishing a template is just publishing an npm package that exports a
<code>Template</code> — a <code>name</code>, a <code>description</code>, a Zod
<code>paramsSchema</code>, and a <code>render(params, ctx)</code> that returns a
self-contained SVG. You add <strong>no rendering code</strong>: the context's
<code>runAnimateConfig</code> (for animated generators) and
<code>captureToSvg</code> (for decorators that wrap a captured page) route your
HTML through the core pipeline, so every fidelity fix is inherited for free.</p>

<p>The repository has the full walkthrough and a runnable scaffold you can copy:</p>

<ul>
  <li><code>docs/74-template-authoring.md</code> — the step-by-step authoring &amp;
  publishing guide (package shape, the two animation constraints, params,
  testing, discovery).</li>
  <li><code>examples/template-package/</code> — a complete, runnable
  <code>domotion-template-quote-card</code> package to copy as your starting
  point.</li>
  <li><code>docs/70-template-system.md</code> — the contract reference
  (<code>Template</code>, the render context, and the output shape).</li>
</ul>
`);
