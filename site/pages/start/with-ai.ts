export const meta = {
  slug: "start/with-ai",
  title: "Using Domotion with AI",
  subtitle: "How to drive captures from Claude Code, Cursor, or any LLM agent.",
};

export const content = `
<p>Domotion fits naturally into AI-driven workflows. The CLI is small enough
to fit in a system prompt, the JSON config is easy for an LLM to author, and
the SVG output is text — so an agent can read it, diff it, and iterate
without leaving the editor.</p>

<h2>Cheat sheet for the agent</h2>

<p>Drop this into your AI's <code>CLAUDE.md</code> / <code>.cursorrules</code>
/ system prompt to give it the minimum it needs:</p>

<pre><code>## Capturing UI as SVG with Domotion

The \`domotion\` CLI renders HTML/CSS to a self-contained, scalable SVG.

Single capture:
  domotion capture &lt;input&gt; -o out.svg [--width N] [--height N]
                                       [--selector ".foo"] [--clip x,y,w,h]
                                       [--scroll x,y] [--wait-for ".ready"]
                                       [--optimize] [--warnings]

  &lt;input&gt; is a URL, a path to an HTML file, or "-" for stdin.

Multi-frame animation:
  domotion animate config.json
  Config schema: { width, height, output, optimize?, frames: [{
    input, duration, transition: { type, duration },
    waitFor?, scroll?, actions?: [
      { type: "click"|"fill"|"press"|"hover"|"scroll"|"wait", ... }
    ],
    overlays?: [...]
  }] }
  Transition types: "crossfade" | "push-left" | "scroll".

Run \`domotion --help\` for the full reference.</code></pre>

<h2>Common patterns</h2>

<h3>Generate the HTML, then capture it</h3>

<p>Have the AI write the HTML for the demo, then run capture. This works
well because the AI can iterate on the source — rerunning the command and
opening the SVG in a browser preview is the feedback loop.</p>

<pre><code><span class="tk-c"># 1. Agent writes demo.html</span>
<span class="tk-c"># 2. Agent runs:</span>
domotion capture demo.html --width 800 --height 400 --optimize -o demo.svg
<span class="tk-c"># 3. Agent reads demo.svg or opens it in a preview to verify</span></code></pre>

<h3>Capture an existing site</h3>

<p>You don't need source access. Point the agent at a URL:</p>

<pre><code>domotion capture https://docs.example.com/getting-started \\
  --width 1200 --selector ".content" --optimize -o doc.svg</code></pre>

<p>Combined with a screenshot diff or visual inspection, this is a useful
loop for "make my docs look like that one".</p>

<h3>Iterate on an animation config</h3>

<p>For multi-frame animations, the AI authors the JSON config rather than a
full TypeScript script. Re-running <code>domotion animate</code> is fast and
the diff between iterations is small.</p>

<pre><code><span class="tk-c"># Agent writes / edits demo.json, then:</span>
domotion animate demo.json
<span class="tk-c"># Agent inspects steps.svg, adjusts duration / transition / actions, repeats.</span></code></pre>

<h2>Tips for prompting</h2>

<ul>
  <li><strong>Show one example HTML file in the prompt.</strong> A 20-line
    snippet of dark-mode HTML is enough for the agent to match your house
    style across frames.</li>
  <li><strong>Be explicit about the output dimensions.</strong>
    "<code>800×400</code> for a marketing card" or
    "<code>390×844</code> for a phone-style demo" stops the agent guessing.</li>
  <li><strong>Ask for <code>--warnings</code> on the first run</strong> so
    the agent sees CSS that didn't round-trip and can adjust the source.</li>
  <li><strong>Prefer the CLI over the JS API</strong> for AI workflows —
    the JSON config is easier to read in a diff than a hand-rolled
    TypeScript loop.</li>
</ul>

<h2>What Domotion can't (yet) do well from a prompt</h2>

<ul>
  <li><strong>Custom interaction loops.</strong> The action vocabulary covers
    click / fill / press / hover / scroll / wait. Anything more (drag-and-drop,
    multi-step async flows) needs the JS API.</li>
  <li><strong>CSS that falls back to raster.</strong>
    <code>backdrop-filter</code>, conic gradients, complex
    <code>clip-path: path()</code> — see <a href="../../css/overview/">CSS
    Support</a>. The agent should learn to avoid these in generated HTML
    when possible.</li>
  <li><strong>Pixel-exact diff iteration.</strong> The output is text-diffable
    but small layout changes can produce large textual diffs. For visual
    iteration, screenshot the SVG between runs.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../cli/">CLI reference</a></li>
  <li><a href="../../guides/animated-demo/">Build an animated demo</a></li>
  <li><a href="../../css/overview/">CSS Support</a> — what to avoid in
    generated HTML.</li>
</ul>
`;
