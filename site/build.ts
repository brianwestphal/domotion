/**
 * Build the Domotion user manual into static HTML in `site/dist/`.
 *
 * Each page is `site/pages/<slug>.tsx` exporting `meta` (PageMeta) and
 * `content` (HTML string). The build script discovers pages via the manifest
 * in `structure.ts` so the sidebar and prev/next links stay in sync.
 *
 * Run: `npx tsx site/build.ts`. Output is suitable for GitHub Pages
 * (a `.nojekyll` is also written to disable Jekyll processing).
 */

import { mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALL_PAGES } from "./structure.js";
import { renderPage, type PageMeta } from "./layout.js";
import { SafeHtml } from "kerfjs";

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SITE_DIR, "..");
const PAGES_DIR = resolve(SITE_DIR, "pages");
const ASSETS_DIR = resolve(SITE_DIR, "assets");
const DIST_DIR = resolve(SITE_DIR, "dist");
// The AI-agent usage guide is served at the site root per the llms.txt
// convention (https://llmstxt.org), so web-fetching agents can discover it at
// `<site>/llms.txt`. Sourced from the repo-root file that also ships in the npm
// package, so the two never drift.
const LLMS_TXT = resolve(REPO_ROOT, "llms.txt");

interface PageModule {
  meta: PageMeta;
  content: SafeHtml;
}

async function loadPage(slug: string): Promise<PageModule> {
  const filename = slug === "" ? "home" : slug;
  const path = resolve(PAGES_DIR, `${filename}.tsx`);
  if (!existsSync(path)) {
    throw new Error(`Missing page module: ${path}`);
  }
  const mod = await import(pathToFileURL(path).href) as Partial<PageModule>;
  if (mod.meta == null || !(mod.content instanceof SafeHtml)) {
    throw new Error(`Page ${slug} must export { meta, content: SafeHtml }`);
  }
  return { meta: mod.meta, content: mod.content };
}

function outputPath(slug: string): string {
  return slug === ""
    ? resolve(DIST_DIR, "index.html")
    : resolve(DIST_DIR, slug, "index.html");
}

async function main(): Promise<void> {
  if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
  mkdirSync(DIST_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;
  const missing: string[] = [];
  for (const ref of ALL_PAGES) {
    try {
      const page = await loadPage(ref.slug);
      if (page.meta.slug !== ref.slug) {
        console.warn(`  ⚠ ${ref.slug}: meta.slug "${page.meta.slug}" doesn't match structure entry`);
      }
      const html = renderPage(page.meta, page.content);
      const out = outputPath(ref.slug);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, html);
      written++;
    } catch (e) {
      // Allow build to proceed even if a page module isn't authored yet, so
      // contributors can scaffold structure first and fill in pages later.
      // The manual is incomplete in that case — flag it loudly.
      missing.push(`${ref.slug}: ${e instanceof Error ? e.message : String(e)}`);
      skipped++;
    }
  }

  // Copy static assets (CSS, images, favicons).
  if (existsSync(ASSETS_DIR)) {
    cpSync(ASSETS_DIR, resolve(DIST_DIR, "assets"), { recursive: true });
  }
  // Serve the AI-agent guide at `<site>/llms.txt` (llms.txt convention).
  if (existsSync(LLMS_TXT)) {
    cpSync(LLMS_TXT, resolve(DIST_DIR, "llms.txt"));
  }
  // Disable Jekyll on GitHub Pages so files like _layouts/ aren't ignored
  // and so paths starting with underscore work normally.
  writeFileSync(resolve(DIST_DIR, ".nojekyll"), "");

  console.log(`\nBuilt ${written} page${written === 1 ? "" : "s"} → ${DIST_DIR}`);
  if (skipped > 0) {
    console.warn(`\n${skipped} page${skipped === 1 ? "" : "s"} not yet authored:`);
    for (const m of missing) {
      console.warn(`  - ${m}`);
    }
  }
}

void main();
