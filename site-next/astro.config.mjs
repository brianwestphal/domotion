// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// DM-1308: the new Domotion site. Astro + Starlight, mirroring ~/Documents/kerf.
// Marketing-forward IA (lead with demos, then the "why", then usage, then dev
// docs last) layered on top of Starlight's docs machinery. Deploys to the same
// GitHub Pages path as the legacy site: brianwestphal.github.io/domotion.
export default defineConfig({
  site: "https://brianwestphal.github.io",
  base: "/domotion",
  integrations: [
    starlight({
      title: "Domotion",
      tagline: "Turn HTML/CSS into a self-contained, animated SVG.",
      description:
        "Domotion captures how headless Chromium paints real HTML/CSS and emits a single self-contained animated SVG — embeds anywhere, scales crisply, looks identical across browsers.",
      logo: { src: "./src/assets/logo.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/brianwestphal/domotion" },
      ],
      customCss: ["./src/styles/site.css"],
      // Marketing-forward order: Showcase → Why → Usage → Developer (last).
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is Domotion?", slug: "start/what-is-domotion" },
            { label: "Showcase", slug: "showcase" },
            { label: "Why Domotion", slug: "why-domotion" },
            { label: "Install & quick start", slug: "start/quickstart" },
          ],
        },
        {
          label: "Usage",
          items: [
            { label: "Capture a page", slug: "usage/capture" },
            { label: "Animate (multi-frame)", slug: "usage/animate" },
            { label: "Templates", slug: "usage/templates" },
            { label: "Terminal sessions", slug: "usage/terminal" },
            { label: "Compositing", slug: "usage/composite" },
            { label: "Export to video / image", slug: "usage/export" },
          ],
        },
        {
          label: "Developer",
          items: [
            { label: "Scripting API", slug: "developer/api" },
            { label: "Animate config format", slug: "developer/animate-config" },
            { label: "Building custom templates", slug: "developer/custom-templates" },
            { label: "Using AI to drive Domotion", slug: "developer/using-ai" },
          ],
        },
      ],
    }),
  ],
});
