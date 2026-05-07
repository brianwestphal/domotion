/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * Showcase integration tests.
 *
 * Uses the actual showcase HTML frames as test cases. These are more complex
 * than the individual feature tests and exercise real-world layout patterns.
 *
 * Usage: npx tsx tests/showcase.tsx [--only frame-name]
 */

import { raw } from "kerfjs";
import { runFeatureTests, type FeatureTest } from "./runner.js";

const WIDTH = 800;
const HEIGHT = 500;

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
h1 { font-size: 28px; font-weight: 800; margin-bottom: 8px; }
h2 { font-size: 18px; font-weight: 600; margin-bottom: 12px; color: #e6edf3; }
p { font-size: 14px; color: #8b949e; line-height: 1.6; margin-bottom: 16px; }
a { color: #58a6ff; text-decoration: none; }
code { font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; background: #161b22; padding: 2px 6px; border-radius: 4px; }
pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; margin-bottom: 16px; overflow: hidden; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.badge-green { background: rgba(35,134,54,0.15); color: #3fb950; border: 1px solid rgba(35,134,54,0.3); }
.badge-blue { background: rgba(31,111,235,0.15); color: #58a6ff; border: 1px solid rgba(31,111,235,0.3); }
.badge-amber { background: rgba(210,153,34,0.15); color: #d29922; border: 1px solid rgba(210,153,34,0.3); }
.btn { display: inline-block; padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid #30363d; }
.btn-primary { background: #238636; border-color: #238636; color: white; }
.btn-secondary { background: #161b22; color: #e6edf3; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin-bottom: 12px; }
.card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.card-title { font-weight: 600; color: #58a6ff; font-size: 14px; }
.card-desc { font-size: 13px; color: #8b949e; }
.card-meta { font-size: 12px; color: #6e7681; margin-top: 8px; }
.label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.input { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; width: 300px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.flex { display: flex; gap: 8px; align-items: center; }
.success { color: #3fb950; }
.error { color: #f85149; }
.dim { color: #6e7681; }
.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.version { background: #161b22; padding: 4px 10px; border-radius: 6px; font-size: 13px; color: #8b949e; }
`;

/** Wraps a body fragment in the full showcase chrome (DOCTYPE / head / body / outer frame). */
function wrap(body: string): string {
  const doc = (
    <html>
      <head>
        <meta charset="utf-8" />
        <style>{raw(CSS)}</style>
      </head>
      <body>
        <div style={`padding: 32px; width: ${WIDTH}px; height: ${HEIGHT}px;`}>
          {raw(body)}
        </div>
      </body>
    </html>
  );
  return `<!DOCTYPE html>${doc.toString()}`;
}

const tests: FeatureTest[] = [
  {
    name: "showcase-typography",
    html: wrap(`
      <h1>SliceKit</h1>
      <p>Snippet Library for Instruction Context Exchange. <a href="#">Learn more</a></p>
      <h2>Text Styles</h2>
      <div class="grid">
        <div>
          <p class="label">BADGES</p>
          <div class="flex">
            <span class="badge badge-green">Published</span>
            <span class="badge badge-blue">v1.2.0</span>
            <span class="badge badge-amber">Stack</span>
          </div>
        </div>
        <div>
          <p class="label">STATUS</p>
          <p><span class="success">✓ Installed successfully</span></p>
          <p><span class="error">✗ Version conflict</span></p>
          <p><span class="dim">Last updated 3 days ago</span></p>
        </div>
      </div>
      <h2>Code</h2>
      <pre>sk install @community/error-handling-patterns</pre>
      <p>Inline code: <code>slicekit.json</code> and <code>CLAUDE.md</code></p>
    `),
    width: WIDTH,
    height: HEIGHT,
  },
  {
    name: "showcase-cards",
    html: wrap(`
      <div class="title-row">
        <h1>@community/error-handling</h1>
        <span class="version">v1.2.0</span>
      </div>
      <p>Structured error handling with typed errors and Result patterns.</p>
      <div class="card">
        <div class="card-header">
          <span class="card-title">@community/typescript-strict</span>
          <span class="badge badge-blue">universal</span>
        </div>
        <p class="card-desc">TypeScript strict mode conventions and type safety rules</p>
        <p class="card-meta">Score: 42/100 · 1,234 downloads · 92% positive</p>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">@community/testing-philosophy</span>
          <span class="badge badge-green">featured</span>
        </div>
        <p class="card-desc">Testing philosophy focusing on behavior, not implementation</p>
        <p class="card-meta">Score: 38/100 · 987 downloads · 88% positive</p>
      </div>
      <div class="flex" style="margin-top: 16px">
        <button class="btn btn-primary">Publish</button>
        <button class="btn btn-secondary">Fork</button>
      </div>
    `),
    width: WIDTH,
    height: HEIGHT,
  },
  {
    name: "showcase-forms",
    html: wrap(`
      <h1>Publish a Snippet</h1>
      <p>Share your AI coding configuration with the community.</p>
      <div style="margin-top: 16px">
        <p class="label">NAME</p>
        <div class="flex" style="margin-bottom: 16px">
          <span style="color: #e6edf3; font-size: 14px; font-weight: 500;">@devuser/</span>
          <input class="input" value="error-handling" />
        </div>
        <p class="label">VERSION</p>
        <input class="input" value="1.0.0" style="margin-bottom: 16px; width: 150px;" />
        <p class="label">DESCRIPTION</p>
        <input class="input" value="Custom error handling rules for our team" style="margin-bottom: 16px; width: 100%;" />
        <p class="label">CONTENT</p>
        <pre style="min-height: 80px;">## Error Handling

- Always use typed errors extending AppError
- Use Result&lt;T, E&gt; for expected failures</pre>
      </div>
      <div class="flex" style="margin-top: 16px">
        <button class="btn btn-primary">Publish</button>
      </div>
    `),
    width: WIDTH,
    height: HEIGHT,
  },
];

void runFeatureTests(tests, "showcase");
