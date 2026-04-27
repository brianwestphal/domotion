export const meta = {
  slug: "start/install",
  title: "Installation",
  subtitle: "Node, the package, and a Chromium binary.",
};

export const content = `
<h2>Requirements</h2>
<ul>
  <li><strong>Node.js 22 or later.</strong> Domotion is published as ESM
    and uses <code>node:</code>-prefix imports throughout.</li>
  <li><strong>Playwright's Chromium browser.</strong> Domotion captures via
    Playwright; you install the browser binary separately so the package itself
    stays small.</li>
  <li><strong>macOS for full font fidelity</strong> (path / font modes only).
    The bundled font lookup table targets Apple system fonts. On Linux and
    Windows, captured text still renders, but path-mode glyphs fall back to
    SVG <code>&lt;text&gt;</code> when no matching system font is found.
    See <a href="../../guides/fonts/">Fonts &amp; non-Latin scripts</a>.</li>
</ul>

<h2>Install the package</h2>

<p>Most users want the <code>domotion</code> CLI globally:</p>

<pre><code>npm install -g domotion</code></pre>

<p>If you'd rather scope it to a project (and run it via
<code>npx domotion</code>), or if you plan to use the JS API too:</p>

<pre><code><span class="tk-c"># With npm</span>
npm install domotion

<span class="tk-c"># With pnpm</span>
pnpm add domotion

<span class="tk-c"># With yarn</span>
yarn add domotion</code></pre>

<h2>Chromium binary</h2>

<p>Domotion captures via Playwright's bundled Chromium build (so captures are
deterministic across machines). The binary is fetched on first use — when you
call <code>launchChromium()</code> from Domotion, or use
<code>DemoRecorder</code>, the package detects a missing binary and runs
<code>npx playwright install chromium</code> for you.</p>

<p>If you'd rather pre-install (e.g. on CI runners, where the install adds
30–60s to the first job), do it explicitly:</p>

<pre><code>npx playwright install chromium</code></pre>

<p>On Linux servers / containers, also pull the system libraries Chromium
depends on:</p>

<pre><code>npx playwright install --with-deps chromium</code></pre>

<div class="callout warn">
  <span class="icon">⚠</span>
  <div class="body">
    <p>If you're calling <code>chromium.launch()</code> directly from
    <code>@playwright/test</code> instead of going through Domotion's
    <code>launchChromium()</code>, you bypass the auto-install step — you'll
    need to run <code>npx playwright install chromium</code> yourself the
    first time.</p>
    <p>Don't <code>npm install playwright</code> separately — Domotion already
    depends on <code>@playwright/test</code> at a known version. Installing
    Playwright manually on top of it can lead to two browser versions on disk
    and confusing capture differences.</p>
  </div>
</div>

<h2>Verify</h2>

<p>Drop this script in a file and run it with <code>npx tsx verify.ts</code>:</p>

<pre><code><span class="tk-k">import</span> { captureElementTree, elementTreeToSvg, launchChromium, wrapSvg } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-k">const</span> browser = <span class="tk-k">await</span> <span class="tk-f">launchChromium</span>();
<span class="tk-k">const</span> page = <span class="tk-k">await</span> browser.<span class="tk-f">newPage</span>();
<span class="tk-k">await</span> page.<span class="tk-f">setContent</span>(<span class="tk-s">'&lt;div style="padding:20px;color:#fff;background:#0d1117"&gt;Hello&lt;/div&gt;'</span>);

<span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, { x: <span class="tk-n">0</span>, y: <span class="tk-n">0</span>, width: <span class="tk-n">400</span>, height: <span class="tk-n">100</span> });
<span class="tk-k">const</span> svg = <span class="tk-f">wrapSvg</span>(<span class="tk-f">elementTreeToSvg</span>(tree, <span class="tk-n">400</span>, <span class="tk-n">100</span>), <span class="tk-n">400</span>, <span class="tk-n">100</span>);

console.<span class="tk-f">log</span>(<span class="tk-s">\`OK — \${svg.length} bytes\`</span>);
<span class="tk-k">await</span> browser.<span class="tk-f">close</span>();</code></pre>

<p>If you see an "OK — N bytes" line, you're set. If you see a Chromium launch
error, jump to <a href="../../help/troubleshooting/">Troubleshooting</a>.</p>

<h2>TypeScript setup</h2>

<p>Domotion ships TypeScript types alongside the JavaScript output (<code>"types":
"dist/index.d.ts"</code> in the package's <code>package.json</code>). No separate
<code>@types/domotion</code> install is needed.</p>

<p>Because Domotion is ESM-only, your project needs <code>"type": "module"</code>
in its <code>package.json</code> or you'll need to use a loader like
<code>tsx</code>. The examples in this manual assume one or the other.</p>

<h2>Project layout suggestion</h2>

<p>Most teams end up with a <code>demos/</code> or <code>marketing-assets/</code>
folder containing one TypeScript file per animation, plus a tiny shared
<code>capture.ts</code> helper:</p>

<pre><code>your-app/
├─ demos/
│  ├─ hero.ts             <span class="tk-c">// produces hero.svg</span>
│  ├─ checkout.ts         <span class="tk-c">// produces checkout.svg</span>
│  ├─ shared.ts           <span class="tk-c">// optimizeSvg, common viewport sizes</span>
│  └─ output/             <span class="tk-c">// generated SVGs (committed or built in CI)</span>
├─ src/                   <span class="tk-c">// your real product code</span>
└─ package.json</code></pre>

<p>You can run them ad-hoc (<code>npx tsx demos/hero.ts</code>) or wire them
into <code>package.json</code> scripts. See the <a href="../quickstart/">Quick
start</a> for a complete first script.</p>
`;
