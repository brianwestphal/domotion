/**
 * Page layout renderer. Wraps a page's HTML body in the shared chrome
 * (`<head>`, sidebar nav, breadcrumb, prev/next).
 */

import { SECTIONS, HOME, findSection, findPrevNext, type PageRef } from "./structure.js";

export interface PageMeta {
  /** URL slug. Must match the entry in structure.ts. */
  slug: string;
  /** Browser tab title and h1. */
  title: string;
  /** Tagline shown under the h1. Optional. */
  subtitle?: string;
  /** Open Graph / meta description. */
  description?: string;
}

/** Render a single page's complete HTML document. */
export function renderPage(meta: PageMeta, body: string): string {
  const isHome = meta.slug === "";
  const section = isHome ? undefined : findSection(meta.slug);
  const { prev, next } = findPrevNext(meta.slug);

  // All same-origin asset URLs are absolute from /domotion/ when served on
  // GH Pages (project page) but plain "/" works locally — use a relative
  // root marker we can rewrite at build time. For now, hard-code "/" since
  // the workflow can deploy to a custom domain or root path.
  const root = relativeRoot(meta.slug);

  const titleSuffix = isHome ? "" : " · Domotion";
  const desc = escapeAttr(meta.description ?? "Domotion: DOM-to-animated-SVG renderer.");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${desc}" />
  <title>${escapeText(meta.title)}${titleSuffix}</title>
  <link rel="stylesheet" href="${root}assets/styles.css" />
  <link rel="icon" type="image/svg+xml" href="${root}assets/favicon.svg" />
</head>
<body class="${isHome ? "home" : "page"}">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <a class="brand" href="${root}">
      <span class="brand-logo" aria-hidden="true">◐</span>
      <span class="brand-name">Domotion</span>
    </a>
    <button class="nav-toggle" aria-label="Toggle navigation" aria-controls="sidebar" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
    <nav class="topnav" aria-label="Primary">
      <a href="${root}start/quickstart/">Quick start</a>
      <a href="${root}api/overview/">API</a>
      <a href="${root}css/overview/">CSS support</a>
      <a href="https://github.com/" rel="noopener" target="_blank">GitHub</a>
    </nav>
  </header>
  <div class="layout">
    ${renderSidebar(meta.slug, root)}
    <main id="main" class="content">
      ${renderBreadcrumb(meta, section, root)}
      <article class="prose">
        <header class="page-head">
          <h1>${escapeText(meta.title)}</h1>
          ${meta.subtitle != null ? `<p class="subtitle">${escapeText(meta.subtitle)}</p>` : ""}
        </header>
        ${body}
      </article>
      ${renderPrevNext(prev, next, root)}
    </main>
  </div>
  <footer class="footer">
    <p>Domotion — DOM-to-animated-SVG renderer. <a href="https://github.com/" rel="noopener">GitHub</a> · <a href="${root}help/troubleshooting/">Help</a></p>
  </footer>
  <script>
    // Mobile sidebar toggle. Tiny inline script — no build step.
    (function () {
      var btn = document.querySelector(".nav-toggle");
      var sidebar = document.getElementById("sidebar");
      if (btn == null || sidebar == null) return;
      btn.addEventListener("click", function () {
        var open = sidebar.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      // Close on nav click for mobile.
      sidebar.addEventListener("click", function (e) {
        var t = e.target;
        if (t && t.tagName === "A" && window.innerWidth < 880) {
          sidebar.classList.remove("open");
          btn.setAttribute("aria-expanded", "false");
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderSidebar(currentSlug: string, root: string): string {
  const items = SECTIONS.map((sec) => {
    const links = sec.pages.map((p) => {
      const isActive = p.slug === currentSlug;
      return `<li><a href="${root}${p.slug}/" class="${isActive ? "active" : ""}">${escapeText(p.title)}</a></li>`;
    }).join("");
    return `
      <li class="sec">
        <h3>${escapeText(sec.title)}</h3>
        <ul>${links}</ul>
      </li>`;
  }).join("");

  const homeActive = currentSlug === "" ? "active" : "";
  return `
    <aside id="sidebar" class="sidebar" aria-label="Manual sections">
      <nav>
        <ul class="nav-list">
          <li class="sec home-link"><a href="${root}" class="${homeActive}">${escapeText(HOME.title)}</a></li>
          ${items}
        </ul>
      </nav>
    </aside>`;
}

function renderBreadcrumb(meta: PageMeta, section: ReturnType<typeof findSection>, root: string): string {
  if (meta.slug === "") return "";
  const parts: string[] = [`<a href="${root}">Home</a>`];
  if (section != null) {
    parts.push(`<span>${escapeText(section.title)}</span>`);
  }
  parts.push(`<span class="current">${escapeText(meta.title)}</span>`);
  return `<nav class="breadcrumb" aria-label="Breadcrumb">${parts.join(`<span class="sep">›</span>`)}</nav>`;
}

function renderPrevNext(prev: PageRef | undefined, next: PageRef | undefined, root: string): string {
  if (prev == null && next == null) return "";
  const prevHtml = prev != null
    ? `<a class="pn-prev" href="${root}${prev.slug}/"><span class="pn-label">← Previous</span><span class="pn-title">${escapeText(prev.title)}</span></a>`
    : `<span></span>`;
  const nextHtml = next != null
    ? `<a class="pn-next" href="${root}${next.slug}/"><span class="pn-label">Next →</span><span class="pn-title">${escapeText(next.title)}</span></a>`
    : `<span></span>`;
  return `<nav class="prev-next" aria-label="Page navigation">${prevHtml}${nextHtml}</nav>`;
}

/**
 * Compute the relative URL prefix to reach the site root from this page.
 * For a page at `start/install` → "../../" so `assets/styles.css` resolves
 * regardless of where the site is hosted (root domain, project page, etc.).
 */
function relativeRoot(slug: string): string {
  if (slug === "") return "";
  const depth = slug.split("/").length;
  return "../".repeat(depth);
}

export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
