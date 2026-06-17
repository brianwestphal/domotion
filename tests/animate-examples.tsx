/**
 * Regression harness for the runnable `domotion animate` examples under
 * examples/animate/.
 *
 * Each example is a real `<name>.json` config + HTML frames + a committed
 * golden `<name>.svg` (the default, unoptimized CLI output — a browser-openable
 * "known output"). This harness re-runs every config through the SAME code the
 * CLI uses (`composeAnimateConfig`, sharing one browser) and checks the result
 * two ways:
 *
 *   1. Byte-diff against the committed golden — but only on the platform that
 *      produced it (macOS today). The text→glyph-path renderer is calibrated to
 *      the host's system fonts; on Linux the same config falls back to <text>,
 *      so a committed macOS golden can't byte-match there. The ONLY source of
 *      same-platform nondeterminism is the embedded-font base64 payload (subset
 *      timestamp/checksum), which we normalize out before comparing.
 *   2. Structural assertions — run on EVERY platform (incl. Linux CI). These
 *      assert the shape of the output (frame groups, transition keyframes,
 *      overlay markup, scroll composite, viewBox, no malformed `%%` stops) so
 *      the pipeline is still guarded where the byte-diff can't run.
 *
 * Usage:
 *   npx tsx tests/animate-examples.tsx              # verify all
 *   npx tsx tests/animate-examples.tsx --only crossfade-cards
 *   npx tsx tests/animate-examples.tsx --update     # rewrite goldens from current output
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromium } from "../src/capture/index.js";
import { composeAnimateConfig, validateAnimateConfig } from "../src/cli/animate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EX_DIR = resolve(ROOT, "examples/animate");
const OUT_DIR = resolve(ROOT, "tests/output");

/** Count non-overlapping matches of `re` (must be a /g regex) in `s`. */
function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

interface Example {
  name: string;
  /** Structural checks; return a list of human-readable failure messages. */
  check: (svg: string) => string[];
}

const EXAMPLES: Example[] = [
  {
    name: "crossfade-cards",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 600 360"`)) f.push("missing viewBox 600x360");
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 composited frame groups");
      // Crossfade must COMPOSITE (per-frame fv- groups), never element-merge (tN).
      if (!/@keyframes fv-0/.test(svg)) f.push("missing fv-0 (crossfade should composite, not merge)");
      if (/@keyframes t\d+\s*{/.test(svg)) f.push("found merge-pipeline tN keyframes — crossfade should not merge");
      return f;
    },
  },
  {
    name: "progress-install",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 700 200"`)) f.push("missing viewBox 700x200");
      if (count(svg, /class="f f-\d+"/g) !== 3) f.push("expected 3 frame groups");
      // Typing overlay (frame 0) + intra-frame width animation (frame 1).
      if (!/typing|domotion-typing|<text/i.test(svg)) f.push("missing typing-overlay text");
      if (!/@keyframes f1-/.test(svg)) f.push("missing intra-frame animation keyframes on frame 1 (progress fill)");
      return f;
    },
  },
  {
    name: "slides-pushleft",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 640 360"`)) f.push("missing viewBox 640x360");
      if (count(svg, /class="f f-\d+"/g) !== 3) f.push("expected 3 frame groups");
      if (count(svg, /@keyframes fp-\d+/g) !== 3) f.push("expected 3 push (fp-) transform keyframes");
      if (!/translateX/.test(svg)) f.push("push-left should use translateX");
      return f;
    },
  },
  {
    name: "before-after-refactor",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 720 400"`)) f.push("missing viewBox 720x400");
      // 3 frames: before(cut) → after(push-left) → after(cut). The trailing
      // identical after-cut frame holds solid as the last frame, working around
      // the push-left last-frame fade (tracked separately as a bug) so the
      // "after" punchline doesn't dissolve. See docs/64-demo-gallery.md.
      if (count(svg, /class="f f-\d+"/g) !== 3) f.push("expected 3 frame groups");
      if (!/@keyframes fp-1/.test(svg)) f.push("missing push (fp-1) keyframes on the after frame");
      if (!/translateX/.test(svg)) f.push("push-left should use translateX");
      return f;
    },
  },
  {
    name: "tab-switcher",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 640 320"`)) f.push("missing viewBox 640x320");
      // 3 frames driven by click actions (.tab-2, .tab-3) on a continued live
      // page, composited with crossfade (per-frame fv- groups, no element merge).
      if (count(svg, /class="f f-\d+"/g) !== 3) f.push("expected 3 frame groups");
      if (!/@keyframes fv-2/.test(svg)) f.push("missing fv-2 (crossfade should composite all 3 frames)");
      if (/@keyframes t\d+\s*{/.test(svg)) f.push("found merge-pipeline tN keyframes — crossfade should not merge");
      return f;
    },
  },
  {
    name: "typing-search",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 720 260"`)) f.push("missing viewBox 720x260");
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 frame group");
      // The typing overlay reveals "how to install" into the search field.
      if (!/<text/.test(svg)) f.push("missing typing-overlay text");
      return f;
    },
  },
  {
    name: "terminal-onboarding",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 720 360"`)) f.push("missing viewBox 720x360");
      // 4 onboarding steps with typing overlays, push-left between them, plus a
      // trailing held cut frame so the final step holds solid (push-left
      // last-frame fade workaround — see docs/64-demo-gallery.md).
      if (count(svg, /class="f f-\d+"/g) !== 5) f.push("expected 5 frame groups (4 steps + held final)");
      if (count(svg, /@keyframes fp-\d+/g) !== 3) f.push("expected 3 push (fp-) transform keyframes");
      if (!/<text/.test(svg)) f.push("missing typing-overlay text");
      return f;
    },
  },
  {
    name: "form-fill",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 560 480"`)) f.push("missing viewBox 560x480");
      // 5 frames: empty → name → email → password → submitted, each driven by
      // click+fill actions on a continued live page; the final click reveals a
      // success message.
      if (count(svg, /class="f f-\d+"/g) !== 5) f.push("expected 5 frame groups");
      if (!/Account created/.test(svg)) f.push("missing submit-success message in final frame");
      return f;
    },
  },
  {
    name: "scroll-landing",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 480 640"`)) f.push("missing viewBox 480x640");
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 frame group");
      // A landing page scrolled top→bottom via a scroll block: nested scroll
      // composite <svg> animated with translate3d; the sticky nav stays put.
      if (count(svg, /<svg/g) < 2) f.push("missing nested scroll-composite <svg>");
      if (!/translate3d/.test(svg)) f.push("scroll composite should animate the inner content (translate3d)");
      return f;
    },
  },
  {
    name: "scroll-feed",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 460 600"`)) f.push("missing viewBox 460x600");
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 frame group");
      // The scroll block composes an inner scroll SVG nested inside the frame.
      if (count(svg, /<svg/g) < 2) f.push("missing nested scroll-composite <svg>");
      if (!/translate3d/.test(svg)) f.push("scroll composite should animate the inner content (translate3d)");
      return f;
    },
  },
  {
    name: "svg-overlay",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 600 360"`)) f.push("missing viewBox 600x360");
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 frame group");
      // The badge.svg overlay is inlined with namespaced ids (f0o…- prefix) so
      // it can't collide with the host document's ids.
      if (!/f0o[a-z0-9]+-badge-card/.test(svg)) f.push("missing namespaced inlined overlay id (badge-card)");
      if (!/Deployed/.test(svg) && !/<text/.test(svg)) f.push("missing inlined overlay content");
      return f;
    },
  },
  {
    name: "magic-move",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 600 360"`)) f.push("missing viewBox 600x360");
      // The shared "Overview" card (data-magic-key="hero") must SLIDE — a
      // magic-move slide keyframe — and, since it also grows, carry a scale.
      if (!/@keyframes mms-/.test(svg)) f.push("missing magic-move slide keyframes (mms-) — card should slide, not cross-fade");
      if (!/transform: translate\([^)]*\) scale\(/.test(svg)) f.push("missing translate·scale affine — card relocates AND resizes");
      // The bridge composite carries the moving card during the window.
      if (count(svg, /class="f mm-\d+"/g) < 1) f.push("missing magic-move bridge composite group");
      // The Draft→Published chip swap is an add/remove → cross-fade (mmf-).
      if (!/@keyframes mmf-/.test(svg)) f.push("missing add/remove cross-fade keyframes (mmf-)");
      // Reduced-motion must cancel the slide (DM-901).
      if (!/@media \(prefers-reduced-motion: reduce\)/.test(svg)) f.push("missing prefers-reduced-motion fallback");
      return f;
    },
  },
];

/**
 * Canonicalize the two same-platform nondeterministic bits before comparing:
 *   - embedded-font base64 payloads (subset timestamp/checksum vary per run)
 *   - the scroll composer's random `scrl-<rand>` id namespace
 * With both collapsed, the rest of the output is byte-stable run-to-run.
 */
function normalize(svg: string): string {
  return svg
    .replace(/data:font\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:font/ttf;base64,__FONT__")
    .replace(/scrl-[a-z0-9]+/g, "scrl-XX");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const isDarwin = process.platform === "darwin";

  const examples = only != null ? EXAMPLES.filter((e) => e.name === only) : EXAMPLES;
  if (examples.length === 0) {
    process.stderr.write(`No example matched --only ${only ?? ""}\n`);
    process.exit(2);
  }

  const browser = await launchChromium();
  let failed = 0;
  try {
    for (const ex of examples) {
      const configPath = resolve(EX_DIR, ex.name, `${ex.name}.json`);
      const goldenPath = resolve(EX_DIR, ex.name, `${ex.name}.svg`);
      if (!existsSync(configPath)) {
        process.stdout.write(`✗ ${ex.name}: config not found (${configPath})\n`);
        failed++;
        continue;
      }
      const cfg = validateAnimateConfig(JSON.parse(readFileSync(configPath, "utf8")));
      const svg = await composeAnimateConfig(browser, cfg, dirname(configPath), () => {});

      if (update) {
        writeFileSync(goldenPath, svg);
        process.stdout.write(`↻ ${ex.name}: golden rewritten (${(svg.length / 1024).toFixed(1)} KB)\n`);
        continue;
      }

      const problems: string[] = [];

      // 1. Structural assertions (every platform).
      problems.push(...ex.check(svg));
      if (/%%/.test(svg)) problems.push("output contains a malformed `%%` keyframe stop");

      // 2. Byte-diff against the committed golden (golden-producing platform only).
      if (!existsSync(goldenPath)) {
        problems.push(`golden missing (${goldenPath}) — run with --update`);
      } else if (isDarwin) {
        const golden = normalize(readFileSync(goldenPath, "utf8"));
        const actual = normalize(svg);
        if (actual !== golden) {
          const outPath = resolve(OUT_DIR, `animate-${ex.name}-actual.svg`);
          writeFileSync(outPath, svg);
          problems.push(`output drifted from committed golden (wrote actual → ${outPath}; regenerate with --update if intended)`);
        }
      }

      if (problems.length === 0) {
        process.stdout.write(`✓ ${ex.name}${isDarwin ? "" : "  (structural only — non-darwin)"}\n`);
      } else {
        failed++;
        process.stdout.write(`✗ ${ex.name}\n`);
        for (const p of problems) process.stdout.write(`    - ${p}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  if (update) {
    process.stdout.write(`\nGoldens updated.\n`);
    return;
  }
  process.stdout.write(`\n${examples.length - failed} passed, ${failed} failed out of ${examples.length}\n`);
  if (failed > 0) process.exit(1);
}

void main();
