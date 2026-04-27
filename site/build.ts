/**
 * Build the Domotion user manual into static HTML in `site/dist/`.
 *
 * Each page is `site/pages/<slug>.ts` exporting `meta` (PageMeta) and
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

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = resolve(SITE_DIR, "pages");
const ASSETS_DIR = resolve(SITE_DIR, "assets");
const DIST_DIR = resolve(SITE_DIR, "dist");

interface PageModule {
  meta: PageMeta;
  content: string;
}

async function loadPage(slug: string): Promise<PageModule> {
  const filename = slug === "" ? "home" : slug;
  const path = resolve(PAGES_DIR, `${filename}.ts`);
  if (!existsSync(path)) {
    throw new Error(`Missing page module: ${path}`);
  }
  const mod = await import(pathToFileURL(path).href) as Partial<PageModule>;
  if (mod.meta == null || typeof mod.content !== "string") {
    throw new Error(`Page ${slug} must export { meta, content }`);
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
        // eslint-disable-next-line no-console
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
  // Disable Jekyll on GitHub Pages so files like _layouts/ aren't ignored
  // and so paths starting with underscore work normally.
  writeFileSync(resolve(DIST_DIR, ".nojekyll"), "");

  // eslint-disable-next-line no-console
  console.log(`\nBuilt ${written} page${written === 1 ? "" : "s"} → ${DIST_DIR}`);
  if (skipped > 0) {
    // eslint-disable-next-line no-console
    console.warn(`\n${skipped} page${skipped === 1 ? "" : "s"} not yet authored:`);
    for (const m of missing) {
      // eslint-disable-next-line no-console
      console.warn(`  - ${m}`);
    }
  }
}

void main();
