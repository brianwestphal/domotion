// Hero layout regression guard.
//
// Protects the homepage hero against the two alignment bugs fixed in the
// `.hero` block of src/styles/site.css:
//
//   1. Desktop imbalance — the animated wordmark + tagline were centered but
//      the action buttons (and the whole .stack grid item) stayed left-packed,
//      because Starlight's splash hero left-aligns its copy/actions at >=50rem
//      (its default layout floats the image into a right-hand column, which we
//      removed). The hero must read as fully centered at every width.
//
//   2. Mobile flow wrap — the four actions wrapped into a ragged flex flow
//      (one filled pill alone on a row, then a filled pill + a text link
//      sharing a row, the filled pills ending up different widths). On phones
//      the actions must stack vertically with the filled buttons sharing one
//      consistent width.
//
// This renders the real built page in Chromium and asserts those invariants by
// measuring DOM rects — the same probe-and-measure approach the main project
// uses for render fidelity. Playwright is resolved from the root project's
// node_modules (the site is developed alongside it); run `npm test` in site/.
//
// Usage:
//   node scripts/check-hero-layout.mjs            # spawns `astro dev`, checks, tears down
//   BASE_URL=http://localhost:4322 node scripts/check-hero-layout.mjs   # reuse a running server

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PATH_ON_SITE = "/domotion/";
const CENTER_TOLERANCE_PX = 2; // a centered block's center should match the hero's
const WIDTH_TOLERANCE_PX = 1; // two "equal width" pills should match this closely

/** Start `astro dev` and resolve once it prints its Local URL. */
async function startDevServer() {
  const proc = spawn("npx", ["astro", "dev", "--port", "0"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let buf = "";
    // Astro still emits ANSI color codes even with FORCE_COLOR/NO_COLOR set, and
    // it injects one between "Local" and the URL — strip them before matching.
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = stripAnsi(buf).match(/Local\s+(https?:\/\/\S+)/);
      // The printed Local URL already carries the /domotion base path; keep only
      // the origin so appending PATH_ON_SITE doesn't double it.
      if (m) resolve(new URL(m[1]).origin);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`astro dev exited early (code ${code})`)));
    setTimeout(() => reject(new Error("timed out waiting for astro dev")), 90_000);
  });
  // A fresh dev server re-optimizes Vite deps on startup, during which requests
  // can fail or the page full-reloads. Poll the SSR HTML until it serves the
  // fully-rendered hero before we start measuring in the browser.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const html = await fetch(baseUrl + PATH_ON_SITE).then((r) => (r.ok ? r.text() : ""));
      if (html.includes('class="hero') && html.includes("sl-link-button")) break;
    } catch {
      // server not accepting connections yet — keep polling
    }
    if (Date.now() > deadline) throw new Error("astro dev never served the hero");
    await new Promise((r) => setTimeout(r, 500));
  }
  return { proc, baseUrl };
}

/** Navigate to the hero and wait for it to settle, tolerating dev-server reloads. */
async function loadHero(page, url) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector(".hero .actions .sl-link-button", { state: "attached", timeout: 8000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(1000);
    }
  }
  throw lastErr;
}

/** Measure the hero's relevant boxes at the current viewport. */
function measureHero() {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: r.left,
      width: r.width,
      center: r.left + r.width / 2,
      flexDirection: cs.flexDirection,
      justifyContent: cs.justifyContent,
    };
  };
  return {
    hero: box(".hero"),
    heroHtml: box(".hero > .hero-html"),
    tagline: box(".hero .copy .tagline"),
    actions: box(".hero .actions"),
    primaryWidths: [...document.querySelectorAll(".hero .actions .sl-link-button.primary")].map(
      (el) => el.getBoundingClientRect().width,
    ),
  };
}

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

let server;
let externalBase = process.env.BASE_URL;
let browser;
try {
  if (!externalBase) {
    server = await startDevServer();
  }
  const baseUrl = externalBase ?? server.baseUrl;
  browser = await chromium.launch();

  // --- Desktop: the hero must be fully centered (DM-1438) -------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loadHero(page, baseUrl + PATH_ON_SITE);
    const m = await page.evaluate(measureHero);
    await ctx.close();

    for (const part of ["heroHtml", "tagline", "actions"]) {
      const b = m[part];
      check(b != null, `desktop: .${part} not found in hero`);
      if (b) {
        check(
          Math.abs(b.center - m.hero.center) <= CENTER_TOLERANCE_PX,
          `desktop: .${part} is not centered in the hero ` +
            `(center ${b.center.toFixed(1)} vs hero ${m.hero.center.toFixed(1)})`,
        );
      }
    }
    // The actions specifically must be a centered row, not left-packed.
    check(
      m.actions?.justifyContent === "center",
      `desktop: .actions justify-content is "${m.actions?.justifyContent}", expected "center"`,
    );
  }

  // --- Mobile: actions stack vertically, filled pills share a width (DM-1439)
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loadHero(page, baseUrl + PATH_ON_SITE);
    const m = await page.evaluate(measureHero);
    await ctx.close();

    check(
      m.actions?.flexDirection === "column",
      `mobile: .actions flex-direction is "${m.actions?.flexDirection}", expected "column" (stacked)`,
    );
    check(m.primaryWidths.length >= 2, "mobile: expected at least two filled (primary) buttons");
    if (m.primaryWidths.length >= 2) {
      const spread = Math.max(...m.primaryWidths) - Math.min(...m.primaryWidths);
      check(
        spread <= WIDTH_TOLERANCE_PX,
        `mobile: filled buttons have inconsistent widths (spread ${spread.toFixed(1)}px): ` +
          m.primaryWidths.map((w) => w.toFixed(1)).join(", "),
      );
    }
  }
} finally {
  await browser?.close();
  server?.proc.kill("SIGTERM");
}

if (failures.length) {
  console.error("✗ hero layout check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("✓ hero layout check passed (desktop centered, mobile actions stacked + consistent)");
