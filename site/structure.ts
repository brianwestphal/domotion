/**
 * Single source of truth for the user manual's page tree.
 *
 * Each page is one TypeScript module under `site/pages/<slug>.tsx` exporting
 * `meta` and `content`. The build script (`site/build.ts`) reads this list,
 * imports each page, and writes the rendered HTML to `site/dist/<slug>/index.html`.
 *
 * Adding a page: drop a new file under `site/pages/`, list it here. Sidebar,
 * prev/next, and the homepage TOC all derive from this list — no other place
 * needs to know about the new page.
 */

export interface PageRef {
  /** URL slug, e.g. "start/install". The home page is "" (empty). */
  slug: string;
  /** Sidebar / nav title. Short. */
  title: string;
}

export interface Section {
  id: string;
  /** Sidebar header. */
  title: string;
  /** One-line blurb shown on the homepage TOC card. */
  blurb: string;
  pages: PageRef[];
}

/** Home page is rendered separately — it isn't part of any section. */
export const HOME: PageRef = { slug: "", title: "Home" };

export const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Start Here",
    blurb: "Install Domotion and capture your first SVG with one command.",
    pages: [
      { slug: "start/what-is-domotion", title: "What is Domotion?" },
      { slug: "start/install",          title: "Installation" },
      { slug: "start/quickstart",       title: "Quick start" },
      { slug: "start/first-capture",    title: "Your first capture" },
      { slug: "start/cli",              title: "CLI reference" },
      { slug: "start/with-ai",          title: "Using with AI" },
    ],
  },
  {
    id: "concepts",
    title: "Concepts",
    blurb: "How Domotion thinks about capture, rendering, and animation.",
    pages: [
      { slug: "concepts/pipeline",      title: "The capture pipeline" },
      { slug: "concepts/element-tree",  title: "The element tree" },
      { slug: "concepts/text-rendering", title: "Text rendering" },
      { slug: "concepts/animation",     title: "Animation model" },
    ],
  },
  {
    id: "guides",
    title: "Guides",
    blurb: "Cookbook recipes for the most common things people build.",
    pages: [
      { slug: "guides/single-frame",     title: "Capture a single frame" },
      { slug: "guides/animated-demo",    title: "Build an animated demo" },
      { slug: "guides/overlays",         title: "Typing & tap overlays" },
      { slug: "guides/fonts",            title: "Fonts & non-Latin scripts" },
      { slug: "guides/optimization",     title: "Optimize output size" },
      { slug: "guides/embedding",        title: "Embed SVGs in your site" },
    ],
  },
  {
    id: "api",
    title: "API Reference",
    blurb: "Every public export, with signatures, parameters, and examples.",
    pages: [
      { slug: "api/overview",                title: "Overview" },
      { slug: "api/capture-element-tree",    title: "captureElementTree()" },
      { slug: "api/element-tree-to-svg",     title: "elementTreeToSvg()" },
      { slug: "api/captured-element",        title: "CapturedElement" },
      { slug: "api/generate-animated-svg",   title: "generateAnimatedSvg()" },
      { slug: "api/animation-config",        title: "AnimationConfig" },
      { slug: "api/overlays",                title: "Overlay types" },
      { slug: "api/demo-recorder",           title: "DemoRecorder" },
      { slug: "api/optimize-svg",            title: "optimizeSvg()" },
    ],
  },
  {
    id: "css",
    title: "CSS Support",
    blurb: "Which CSS features round-trip faithfully — and which don't.",
    pages: [
      { slug: "css/overview",        title: "Overview" },
      { slug: "css/text-and-fonts",  title: "Text & fonts" },
      { slug: "css/colors-bg",       title: "Colors & backgrounds" },
      { slug: "css/gradients",       title: "Gradients" },
      { slug: "css/borders",         title: "Borders & radius" },
      { slug: "css/layout",          title: "Layout" },
      { slug: "css/transforms",      title: "Transforms" },
      { slug: "css/form-controls",   title: "Form controls" },
      { slug: "css/writing-mode",    title: "Writing mode (RTL / vertical)" },
    ],
  },
  {
    id: "help",
    title: "Help",
    blurb: "Troubleshooting, FAQ, contributing.",
    pages: [
      { slug: "help/troubleshooting", title: "Troubleshooting" },
      { slug: "help/faq",             title: "FAQ" },
      { slug: "help/contributing",    title: "Contributing" },
    ],
  },
];

/** Flat ordered list (used for prev/next navigation). */
export const ALL_PAGES: PageRef[] = [
  HOME,
  ...SECTIONS.flatMap((s) => s.pages),
];

export function findPrevNext(slug: string): { prev?: PageRef; next?: PageRef } {
  const idx = ALL_PAGES.findIndex((p) => p.slug === slug);
  if (idx < 0) return {};
  return {
    prev: idx > 0 ? ALL_PAGES[idx - 1] : undefined,
    next: idx < ALL_PAGES.length - 1 ? ALL_PAGES[idx + 1] : undefined,
  };
}

export function findSection(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.pages.some((p) => p.slug === slug));
}
