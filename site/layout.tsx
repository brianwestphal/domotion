/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

/**
 * Page layout renderer. Wraps a page's HTML body in the shared chrome
 * (`<head>`, sidebar nav, breadcrumb, prev/next).
 */

import { raw, type SafeHtml } from "kerfjs";
import { findPrevNext, findSection, HOME, SECTIONS, type PageRef, type Section } from "./structure.js";

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
export function renderPage(meta: PageMeta, body: SafeHtml): string {
  const isHome = meta.slug === "";
  const section = isHome ? undefined : findSection(meta.slug);
  const { prev, next } = findPrevNext(meta.slug);
  const root = relativeRoot(meta.slug);
  const titleSuffix = isHome ? "" : " · Domotion";
  const desc = meta.description ?? "Domotion: DOM-to-animated-SVG renderer.";

  const doc = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={desc} />
        <title>{`${meta.title}${titleSuffix}`}</title>
        <link rel="stylesheet" href={`${root}assets/styles.css`} />
        <link rel="icon" type="image/svg+xml" href={`${root}assets/favicon.svg`} />
      </head>
      <body className={isHome ? "home" : "page"}>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="topbar">
          <a className="brand" href={root}>
            <span className="brand-logo" aria-hidden="true">◐</span>
            <span className="brand-name">Domotion</span>
          </a>
          <button className="nav-toggle" aria-label="Toggle navigation" aria-controls="sidebar" aria-expanded="false">
            <span></span><span></span><span></span>
          </button>
          <nav className="topnav" aria-label="Primary">
            <a href={`${root}start/quickstart/`}>Quick start</a>
            <a href={`${root}api/overview/`}>API</a>
            <a href={`${root}css/overview/`}>CSS support</a>
            <a href="https://github.com/brianwestphal/domotion" rel="noopener" target="_blank">GitHub</a>
          </nav>
        </header>
        <div className="layout">
          <Sidebar currentSlug={meta.slug} root={root} />
          <main id="main" className="content">
            <Breadcrumb meta={meta} section={section} root={root} />
            <article className="prose">
              <header className="page-head">
                <h1>{meta.title}</h1>
                {meta.subtitle != null ? <p className="subtitle">{meta.subtitle}</p> : null}
              </header>
              {body}
            </article>
            <PrevNext prev={prev} next={next} root={root} />
          </main>
        </div>
        <Footer root={root} />
        {/* eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- static string constant defined below; no untrusted input */}
        {raw(MOBILE_TOGGLE_SCRIPT)}
      </body>
    </html>
  );

  return `<!DOCTYPE html>\n${doc.toString()}`;
}

function Sidebar({ currentSlug, root }: { currentSlug: string; root: string }): SafeHtml {
  const homeActive = currentSlug === "" ? "active" : "";
  return (
    <aside id="sidebar" className="sidebar" aria-label="Manual sections">
      <nav>
        <ul className="nav-list">
          <li className="sec home-link">
            <a href={root} className={homeActive}>{HOME.title}</a>
          </li>
          {SECTIONS.map((sec) => (
            <li className="sec">
              <h3>{sec.title}</h3>
              <ul>
                {sec.pages.map((p) => (
                  <li>
                    <a href={`${root}${p.slug}/`} className={p.slug === currentSlug ? "active" : ""}>
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function Breadcrumb({ meta, section, root }: { meta: PageMeta; section: Section | undefined; root: string }): SafeHtml {
  if (meta.slug === "") return <></>;
  const sep = <span className="sep">›</span>;
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <a href={root}>Home</a>
      {section != null ? <>{sep}<span>{section.title}</span></> : null}
      {sep}
      <span className="current">{meta.title}</span>
    </nav>
  );
}

function PrevNext({ prev, next, root }: { prev: PageRef | undefined; next: PageRef | undefined; root: string }): SafeHtml {
  if (prev == null && next == null) return <></>;
  return (
    <nav className="prev-next" aria-label="Page navigation">
      {prev != null ? (
        <a className="pn-prev" href={`${root}${prev.slug}/`}>
          <span className="pn-label">← Previous</span>
          <span className="pn-title">{prev.title}</span>
        </a>
      ) : <span></span>}
      {next != null ? (
        <a className="pn-next" href={`${root}${next.slug}/`}>
          <span className="pn-label">Next →</span>
          <span className="pn-title">{next.title}</span>
        </a>
      ) : <span></span>}
    </nav>
  );
}

function Footer({ root }: { root: string }): SafeHtml {
  return (
    <footer className="footer">
      <p>
        Domotion — DOM-to-animated-SVG renderer.{" "}
        <a href="https://github.com/brianwestphal/domotion" rel="noopener">GitHub</a>
        {" · "}
        <a href={`${root}help/troubleshooting/`}>Help</a>
      </p>
    </footer>
  );
}

const MOBILE_TOGGLE_SCRIPT = `<script>
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
  </script>`;

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
