/**
 * Walk every page of the built manual in Playwright and report any
 * broken links, missing images, or missing layout pieces.
 *
 * Run: assumes the manual is built (`npx tsx site/build.ts`) and the preview
 * server is running on PORT (default 4180): `PORT=4180 npx tsx site/serve.ts`.
 *
 * Then: `npx tsx site/scripts/walk.ts`
 */

import { chromium, type Page } from "@playwright/test";
import { ALL_PAGES } from "../structure.js";

const BASE = `http://localhost:${process.env.PORT ?? "4180"}`;

interface PageReport {
  slug: string;
  url: string;
  status: number;
  hasH1: boolean;
  hasSidebar: boolean;
  hasBreadcrumb: boolean;
  hasPrevNext: boolean;
  brokenImages: string[];
  brokenLinks: string[];
  consoleErrors: string[];
}

const linkCache = new Map<string, boolean>();

async function checkLink(page: Page, href: string): Promise<boolean> {
  if (linkCache.has(href)) return linkCache.get(href)!;
  try {
    const r = await page.request.get(href);
    const ok = r.ok();
    linkCache.set(href, ok);
    return ok;
  } catch {
    linkCache.set(href, false);
    return false;
  }
}

async function checkPage(page: Page, slug: string): Promise<PageReport> {
  const url = slug === "" ? `${BASE}/` : `${BASE}/${slug}/`;
  const errors: string[] = [];
  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`); });

  const resp = await page.goto(url, { waitUntil: "networkidle" });
  const status = resp?.status() ?? 0;

  const hasH1 = (await page.locator("h1").count()) > 0;
  const hasSidebar = slug === "" ? true : (await page.locator("#sidebar").count()) > 0;
  const hasBreadcrumb = slug === "" ? true : (await page.locator(".breadcrumb").count()) > 0;
  const hasPrevNext = slug === "" ? true : (await page.locator(".prev-next").count()) > 0;

  const brokenImages: string[] = [];
  const imgs = await page.$$("img");
  for (const img of imgs) {
    const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
    if (naturalWidth === 0) {
      const src = await img.getAttribute("src");
      brokenImages.push(src ?? "(no src)");
    }
  }

  const brokenLinks: string[] = [];
  const hrefs = await page.$$eval("a[href]", (els) => (els as HTMLAnchorElement[]).map((a) => a.href));
  const sameOriginHrefs = hrefs
    .filter((h) => h.startsWith(BASE))
    .map((h) => h.split("#")[0]); // strip fragments
  const seenOnPage = new Set<string>();
  for (const href of sameOriginHrefs) {
    if (seenOnPage.has(href)) continue;
    seenOnPage.add(href);
    const ok = await checkLink(page, href);
    if (!ok) brokenLinks.push(href);
  }

  return {
    slug, url, status, hasH1, hasSidebar, hasBreadcrumb, hasPrevNext,
    brokenImages, brokenLinks, consoleErrors: errors,
  };
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const reports: PageReport[] = [];
  for (const ref of ALL_PAGES) {
    process.stdout.write(`  ${ref.slug || "(home)"}... `);
    const report = await checkPage(page, ref.slug);
    reports.push(report);
    // eslint-disable-next-line no-console
    console.log(formatStatus(report));
  }

  await browser.close();

  const failures = reports.filter((r) =>
    r.status !== 200 || !r.hasH1 || !r.hasSidebar || !r.hasBreadcrumb || !r.hasPrevNext
    || r.brokenImages.length > 0 || r.brokenLinks.length > 0 || r.consoleErrors.length > 0,
  );
  // eslint-disable-next-line no-console
  console.log(`\n${reports.length - failures.length}/${reports.length} pages clean.`);
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\nIssues:`);
    for (const r of failures) {
      // eslint-disable-next-line no-console
      console.log(`\n  ${r.slug || "(home)"}  [${r.status}]`);
      if (!r.hasH1)         console.log(`    ⚠ missing h1`);
      if (!r.hasSidebar)    console.log(`    ⚠ missing #sidebar`);
      if (!r.hasBreadcrumb) console.log(`    ⚠ missing .breadcrumb`);
      if (!r.hasPrevNext)   console.log(`    ⚠ missing .prev-next`);
      for (const img of r.brokenImages) console.log(`    ⚠ broken image: ${img}`);
      for (const link of r.brokenLinks) console.log(`    ⚠ broken link: ${link}`);
      for (const err of r.consoleErrors) console.log(`    ⚠ ${err}`);
    }
    process.exit(1);
  }
}

function formatStatus(r: PageReport): string {
  const flags: string[] = [];
  if (r.status !== 200)        flags.push(`HTTP ${r.status}`);
  if (!r.hasH1)                flags.push("no h1");
  if (!r.hasSidebar)           flags.push("no sidebar");
  if (!r.hasBreadcrumb)        flags.push("no breadcrumb");
  if (!r.hasPrevNext)          flags.push("no prev-next");
  if (r.brokenImages.length)   flags.push(`${r.brokenImages.length} broken img`);
  if (r.brokenLinks.length)    flags.push(`${r.brokenLinks.length} broken link`);
  if (r.consoleErrors.length)  flags.push(`${r.consoleErrors.length} console err`);
  return flags.length === 0 ? "✓" : `✗ ${flags.join(", ")}`;
}

void main();
