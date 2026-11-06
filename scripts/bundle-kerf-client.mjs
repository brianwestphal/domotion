// Shared esbuild step for the kerf browser clients that use `@kerfjs/ui`.
//
// `@kerfjs/ui` visual components are imported from their JavaScript subpaths;
// under the `browser` export condition each subpath pulls in its own CSS
// (foundation tokens plus the component's rules). esbuild emits that CSS as a
// second output file. The shipped pages are served as one HTML shell plus one
// `/client.js`, and must stay self-contained and offline, so the CSS is folded
// back into the JavaScript: a prologue prepends one `<style data-kerf-ui>`
// element to `<head>` before any client code runs. Prepending keeps the
// package styles FIRST in the cascade, so each page's own stylesheet (inlined
// later in the document) overrides package defaults without specificity games.
//
// Only the non-Web-Awesome kerf-ui subset is used: kerf `Select` registers Web
// Awesome elements whose icons resolve through the Font Awesome CDN, which
// would break the offline contract (see docs/54-svg-review-tool.md).

import { build } from "esbuild";

/**
 * @param {{ entry: string, format?: "iife" | "esm", sourcemap?: boolean | "inline", minify?: boolean }} opts
 * @returns {Promise<{ js: string, css: string }>} `js` already carries the CSS prologue.
 */
export async function bundleKerfClient({ entry, format = "iife", sourcemap = false, minify = false }) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    outdir: "kerf-client-out",
    format,
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "kerfjs",
    legalComments: "none",
    minify,
    treeShaking: true,
    sourcemap,
    sourcesContent: true,
    logLevel: "warning",
  });
  const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
  const cssFile = result.outputFiles.find((f) => f.path.endsWith(".css"));
  if (jsFile == null) throw new Error(`esbuild produced no JavaScript for ${entry}`);
  // esbuild appends a `/*# sourceMappingURL */` comment to inline-sourcemapped
  // CSS; strip it — the CSS is injected as text, not loaded from a URL.
  const css = cssFile != null ? cssFile.text.replace(/\/\*# sourceMappingURL=[^*]*\*\/\s*$/u, "").trimEnd() : "";
  const prologue =
    css === ""
      ? ""
      : `(()=>{const s=document.createElement("style");s.setAttribute("data-kerf-ui","");s.textContent=${JSON.stringify(css)};document.head.prepend(s);})();`;
  return { js: prologue + jsFile.text, css };
}
