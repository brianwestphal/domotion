/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../src/jsx-runtime.js";
import { SECTIONS } from "../structure.js";

export const meta = {
  slug: "",
  title: "Domotion",
  description: "DOM-to-animated-SVG renderer. Capture HTML/CSS in headless Chromium and emit pixel-faithful, self-contained SVG.",
};

export const content: SafeHtml = (
  <>
    <section className="hero">
      <h1>Pixel-faithful HTML, served as a single SVG.</h1>
      <p className="tagline">
        Domotion captures real HTML/CSS rendered in headless Chromium and converts it into a
        self-contained, scalable SVG — with optional CSS keyframe animations across multiple frames.
        Authored as plain HTML, shipped as <code>{`<img src="demo.svg">`}</code>.
      </p>
      <div className="cta">
        <a className="btn primary" href="start/quickstart/">Quick start →</a>
        <a className="btn" href="start/what-is-domotion/">Why Domotion?</a>
        <a className="btn" href="api/overview/">API reference</a>
      </div>
      <figure style="margin:32px auto 0;max-width:720px;">
        <img src="assets/img/hero-card.svg" alt="Example Domotion capture: a card with a gradient logo, headline, and code snippet — rendered to SVG by Domotion itself." style="width:100%;height:auto;border-radius:14px;border:1px solid var(--line);" />
        <figcaption style="margin-top:10px;font-size:13px;color:var(--fg-muted);">Above: SVG produced by Domotion from the HTML on its left. Same pipeline this manual teaches.</figcaption>
      </figure>
    </section>

    <section>
      <h2 style="text-align:center;border:none;font-size:18px;color:var(--fg-muted);font-weight:500;margin-top:40px;">
        Three things make it useful
      </h2>
      <div className="toc-grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
        <div className="toc-card">
          <h3>Real HTML, real CSS</h3>
          <p>Author your demo in your real app, your real component library, your real fonts. No re-implementing layout in a vector tool.</p>
        </div>
        <div className="toc-card">
          <h3>One file, lazy-loaded</h3>
          <p>Output is a single self-contained SVG. No external images, no script, no font fetches. Drops into <code>{`<img>`}</code> and lazy-loads with the rest of your page.</p>
        </div>
        <div className="toc-card">
          <h3>Scales without artifacts</h3>
          <p>Vector text and shapes, not raster screenshots. Crisp on retina, crisp at 4× zoom, crisp embedded at any width.</p>
        </div>
      </div>
    </section>

    <section style="margin-top:48px;">
      <h2 style="border:none;text-align:center;font-size:22px;">Manual</h2>
      <div className="toc-grid">
        {SECTIONS.map((sec) => {
          const firstSlug = sec.pages[0]?.slug ?? "";
          const visible = sec.pages.slice(0, 4);
          const more = sec.pages.length > 4 ? sec.pages.length - 4 : 0;
          return (
            <a className="toc-card" href={`${firstSlug}/`}>
              <h3>{sec.title}</h3>
              <p>{sec.blurb}</p>
              <ul>
                {visible.map((p) => <li>{p.title}</li>)}
                {more > 0 ? <li>{`+${more} more`}</li> : null}
              </ul>
            </a>
          );
        })}
      </div>
    </section>

    <section style="margin-top:48px;text-align:center;">
      <h2 style="border:none;font-size:18px;color:var(--fg-muted);font-weight:500;">Animated SVG, looping natively in your browser</h2>
      <figure style="margin:16px auto;max-width:640px;">
        <img src="assets/img/install-demo.svg" alt="Three-frame terminal animation: 'npm install domotion' typing in, a progress bar resolving dependencies, then a green checkmark with the installed packages list." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
        <figcaption style="margin-top:10px;font-size:13px;color:var(--fg-muted);">Three captured HTML states stitched into one SVG with crossfades — no JavaScript at runtime.</figcaption>
      </figure>
    </section>

    <section style="margin-top:40px;text-align:center;">
      <h2 style="border:none;font-size:18px;color:var(--fg-muted);font-weight:500;">One install, one command</h2>
      <pre style="display:inline-block;text-align:left;margin:0 auto;">{raw(`npm install -g domotion
domotion capture https://example.com -o example.svg`)}</pre>
      <p style="margin-top:6px;font-size:13px;color:var(--fg-muted);">Chromium auto-installs on first capture. Drop down to the <a href="api/overview/">JS API</a> when you outgrow the CLI.</p>
      <p style="margin-top:12px;"><a href="start/quickstart/">Quick start →</a></p>
    </section>
  </>
);
