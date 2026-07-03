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
      // Frame 0 types the command with a blinking caret; frame 1 fills the
      // progress bar by revealing a full-width fill via a clip-path inset
      // (not by animating width% on a captured zero-width rect, which doesn't
      // paint — that was the old bug).
      if (!/typing|domotion-typing|<text/i.test(svg)) f.push("missing typing-overlay text");
      if (!/@keyframes f1-/.test(svg)) f.push("missing intra-frame animation keyframes on frame 1 (progress fill)");
      if (!/clip-path|clipPath|inset\(/.test(svg)) f.push("missing clip-path reveal on the progress fill");
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
      // 2 frames: before(push-left) → after(push-left). Both frames carry the
      // slide so `after` slides IN as `before` slides out (push-left is a
      // coordinated pair); `after` is the last frame and holds solid via the
      // DM-1207 last-frame hold.
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 frame groups");
      if (!/@keyframes fp-0/.test(svg) || !/@keyframes fp-1/.test(svg)) f.push("both frames should carry push (fp-) keyframes");
      if (!/translateX/.test(svg)) f.push("push-left should use translateX");
      // The last (after) frame must HOLD solid — transform translateX(0) at
      // 100%, not slide out to -720px (DM-1207 regression guard).
      if (!/@keyframes fp-1 \{[^@]*100%\s*\{\s*transform:\s*translateX\(0\)/.test(svg)) f.push("after frame should hold at translateX(0) to 100% (DM-1207)");
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
    name: "form-fill",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 560 480"`)) f.push("missing viewBox 560x480");
      // 4 frames on a continued live page: each field is TYPED with a caret
      // typing overlay, then `fill`ed for real so it persists while the next
      // field types; the final frame clicks submit and reveals a success
      // message. (Typing overlays render <text>.)
      if (count(svg, /class="f f-\d+"/g) !== 4) f.push("expected 4 frame groups");
      if (!/<text/.test(svg)) f.push("missing typing-overlay text (fields should type, not instant-fill)");
      if (!/Account created/.test(svg)) f.push("missing submit-success message in final frame");
      return f;
    },
  },
  {
    // DM-1556 (docs/93 §2): per-keystroke real-site re-sampling. One frame types
    // "4155550142" into a phone field one key at a time, re-capturing the page
    // after each keystroke — so the field's OWN input mask ("(415) 555-0142") and
    // its `.valid` green border are what get serialized, NOT the raw keystrokes a
    // synthetic typing overlay would paint. The N captures compose into a nested
    // per-keystroke animated SVG (the cast/template nesting pattern).
    name: "caret-shapes",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 720 260"`)) f.push("missing viewBox 720x260");
      // DM-1591: three typing overlays with bar / block / underscore carets.
      const carets = [...svg.matchAll(/<rect class="t\d+-caret"[^>]*\/>/g)].map((m) => m[0]);
      if (carets.length !== 3) f.push(`expected 3 caret rects, got ${carets.length}`);
      // A block caret is a translucent (fill-opacity 0.5), cell-wide box.
      if (!carets.some((c) => /fill-opacity="0\.5"/.test(c) && /width="1[0-9.]+"/.test(c))) f.push("missing translucent block caret");
      // An underscore caret is a thin (small height) cell-wide bar.
      if (!carets.some((c) => /height="[12]"/.test(c) && /width="1[0-9.]+"/.test(c))) f.push("missing thin underscore caret");
      // A bar caret is width 2, opaque.
      if (!carets.some((c) => /width="2"/.test(c) && !/fill-opacity/.test(c))) f.push("missing bar caret");
      return f;
    },
  },
  {
    name: "type-resample",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 500 280"`)) f.push("missing viewBox 500x280");
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 outer frame group");
      // The per-keystroke captures nest as their own animated <svg> (cast/template
      // pattern), namespaced with the `tr0_` per-frame token.
      if (count(svg, /<svg/g) < 2) f.push("missing nested per-keystroke animated <svg>");
      // 11 states (0..10 chars typed): the final `tr0_f-10` must be present.
      if (!/tr0_f-10\b/.test(svg)) f.push("missing the final (10-keystroke) re-sampled state tr0_f-10");
      // Each state carries the field's real blinking caret (measured from selectionEnd).
      if (!/@keyframes tr0_blink\d+/.test(svg)) f.push("missing the re-sampled caret (blink overlay per state)");
      // The re-sampled states are glyph-path <text> of the MASKED value (macOS).
      if (!/<(text|path)/.test(svg)) f.push("missing rendered field content");
      return f;
    },
  },
  {
    // DM-1564 (docs/94 option 3): MutationObserver JS-change harness. One frame
    // dispatches `mouseover` on an "Account" button whose JS INJECTS a dropdown
    // menu (+1 node) and flips `aria-expanded="true"` (which the page's own CSS
    // then styles blue). The harness observes those mutations until they settle
    // and synthesizes a rest→after crossfade — feedback CSS pseudo-state forcing
    // (forceState) fundamentally cannot capture.
    name: "js-reveal",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 420 300"`)) f.push("missing viewBox 420x300");
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 outer frame group");
      // The rest→after states nest as their own crossfaded animated <svg>,
      // namespaced with the `jr0_` per-frame token.
      if (count(svg, /<svg/g) < 2) f.push("missing nested rest→after animated <svg>");
      // Crossfade composites BOTH states (per-frame fv- groups), never merges.
      if (!/jr0_fv-1\b/.test(svg)) f.push("missing the after state (jr0_fv-1) — crossfade should composite rest→after");
      if (!/@keyframes jr0_fv-1/.test(svg)) f.push("missing the rest→after crossfade keyframes (jr0_fv-)");
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
    name: "cursor-auto",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 560 320"`)) f.push("missing viewBox 560x320");
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 frame groups");
      // `cursor: "auto"` derives a global cursor overlay that glides the pointer
      // to each click/hover/fill target and pulses on click. Exercises the
      // `autoCursorTargets.push` recording path in the captured-frame body.
      if (!/class="cursor-overlay"/.test(svg)) f.push("missing cursor-overlay group");
      // DM-1507: the cursor glide is CSS `@keyframes` (translate), NOT SMIL — SMIL
      // runs on a separate timeline that desyncs from the CSS frames offscreen.
      if (!/@keyframes co-pos-[a-z0-9]+\{/.test(svg)) f.push("missing cursor glide (CSS co-pos keyframes)");
      if (/<animateTransform|<animate /.test(svg)) f.push("cursor must be CSS, not SMIL (found <animate*>)");
      if (!/class="cursor-click cursor-click-\d+"/.test(svg)) f.push("missing auto click-pulse (cursor-click-N)");
      if (!/class="cursor-pointer"/.test(svg)) f.push("missing cursor glyph");
      return f;
    },
  },
  {
    name: "cursor-events",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 560 320"`)) f.push("missing viewBox 560x320");
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 frame groups");
      // An explicit `cursor.events` list: a `move` to fixed coords (60,60) then a
      // `moveClick` whose `.cta` selector resolves to the button center. Exercises
      // the `explicitCursorBoxes.set` recording path in the captured-frame body —
      // the glide must pass through the literal 60,60 waypoint.
      if (!/class="cursor-overlay"/.test(svg)) f.push("missing cursor-overlay group");
      // DM-1507: CSS `@keyframes` glide (was SMIL). The 60,60 waypoint is a
      // `translate(60px,60px)` keyframe; must be CSS, not SMIL.
      if (!/@keyframes co-pos-[a-z0-9]+\{/.test(svg)) f.push("missing cursor glide (CSS co-pos keyframes)");
      if (/<animateTransform|<animate /.test(svg)) f.push("cursor must be CSS, not SMIL (found <animate*>)");
      if (!/translate\(60px,60px\)/.test(svg)) f.push("missing explicit 60,60 waypoint in cursor glide");
      if (!/class="cursor-click cursor-click-\d+"/.test(svg)) f.push("missing moveClick click-pulse (cursor-click-N)");
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
  {
    // DM-1516 (docs/94): forced CSS pseudo-state capture. Frame 1 forces `.cta`
    // into `:hover` via CDP before capture, so the frame paints the page's OWN
    // hover rules — the brighter button (#2ea043 → rgb(46,160,67)), NOT the rest
    // color (#238636 → rgb(35,134,54)). The `.card:has(.cta:hover)` sibling rule
    // fires too, so the cascade — not just the hovered node — is captured.
    name: "hover-state",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 460 320"`)) f.push("missing viewBox 460x320");
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 composited frame groups (rest + forced-hover)");
      const frames = svg.split(/(?=class="f f-\d+")/);
      const rest = frames.find((c) => /class="f f-0"/.test(c)) ?? "";
      const hover = frames.find((c) => /class="f f-1"/.test(c)) ?? "";
      // Frame 0 = rest: the button is the base green, not the hover green.
      if (!rest.includes("rgb(35,134,54)")) f.push("frame 0 (rest) missing the base button color rgb(35,134,54)");
      if (rest.includes("rgb(46,160,67)")) f.push("frame 0 (rest) unexpectedly shows the :hover color — forceState leaked into the rest frame");
      // Frame 1 = forced :hover: the page's OWN hover color is captured.
      if (!hover.includes("rgb(46,160,67)")) f.push("frame 1 (forced :hover) missing the captured hover color rgb(46,160,67) — forceState did not reach the capture (session detached too early?)");
      return f;
    },
  },
  {
    // DM-1543 + DM-1544: one brand, set via the config's own `brand` key (no CLI
    // flag), themes BOTH a `template` frame (its brand defaults — the accent bar
    // + logo mark) AND a captured page (CSS-var injection — the orange accent
    // eyebrow / purple CTA). Two composited frames, crossfaded.
    name: "brand-mixed",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 720 405"`)) f.push("missing viewBox 720x405");
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 composited frame groups (template + captured)");
      // The brand's logo asset (an <img src="*.svg">) lands on the template
      // frame's banner inlined as a native, resolution-independent <svg> — its
      // own viewBox="0 0 100 100" — rather than a rasterized-on-zoom
      // <image data:image/svg+xml> (DM-1588).
      if (!/viewBox="0 0 100 100"/.test(svg)) f.push("missing the brand logo native <svg> (viewBox 0 0 100 100) — brand.logo did not reach the template frame's mark, or was not inlined natively");
      // The brand's orange accent (#f97316 → rgb(249,115,22)) appears — the
      // lower-third accent bar (template brand default) and the page's injected
      // --brand-accent eyebrow.
      if (!/rgb\(249, ?115, ?22\)/.test(svg)) f.push("missing the brand accent rgb(249,115,22) — brand did not theme the frames");
      // The purple primary (#7c3aed → rgb(124,58,237)) rides the captured page's
      // CTA (an injected var), proving CSS-var injection reached the captured frame.
      if (!/rgb\(124, ?58, ?237\)/.test(svg)) f.push("missing the brand primary rgb(124,58,237) — CSS-var injection did not reach the captured frame");
      return f;
    },
  },
  {
    // DM-1562 (docs/94 Option 1): `hoverReveal` sugar. A single frame + one field
    // (`hoverReveal: { selector: ".cta" }`) auto-expands into rest + forced-:hover
    // frames with a crossfade and a cursor move onto the button — the same output
    // as the hand-wired hover-state demo, from one line. The card's background
    // changed on hover, so it's a paint reveal → a rest→hover crossfade.
    name: "hover-reveal",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 460 320"`)) f.push("missing viewBox 460x320");
      if (count(svg, /class="f f-\d+"/g) !== 2) f.push("expected 2 composited frame groups (rest + forced-hover)");
      const frames = svg.split(/(?=class="f f-\d+")/);
      const rest = frames.find((c) => /class="f f-0"/.test(c)) ?? "";
      const hover = frames.find((c) => /class="f f-1"/.test(c)) ?? "";
      if (!rest.includes("rgb(35,134,54)")) f.push("frame 0 (rest) missing the base button color rgb(35,134,54)");
      if (rest.includes("rgb(46,160,67)")) f.push("frame 0 (rest) unexpectedly shows the :hover color — hoverReveal leaked into the rest frame");
      if (!hover.includes("rgb(46,160,67)")) f.push("frame 1 (reveal) missing the captured :hover color rgb(46,160,67)");
      // Crossfade compositing between the two frames (opacity groups, not a merge).
      if (!/@keyframes fv-0/.test(svg)) f.push("missing fv-0 crossfade keyframes between rest and reveal");
      return f;
    },
  },
  {
    // DM-1563 (docs/94 Option 2): `hoverDetect` auto-detection. The pre-pass drives
    // a real :hover, diffs computed style, and finds ONLY a transform change (a
    // pure scale) — a MOTION reveal — so it keeps ONE frame and adds an intra-frame
    // keyframe tween (scale 1 → 1.08) instead of a crossfade. Proof the detection
    // + synthesis reached the rendered SVG.
    name: "hover-detect",
    check: (svg) => {
      const f: string[] = [];
      if (!svg.includes(`viewBox="0 0 420 240"`)) f.push("missing viewBox 420x240");
      // Motion mode → a single composited frame (no rest/hover pair).
      if (count(svg, /class="f f-\d+"/g) !== 1) f.push("expected 1 frame group (motion-only hover → intra-frame tween, not a crossfade pair)");
      // The button's own color survives (the paint wasn't touched).
      if (!svg.includes("rgb(110,64,201)")) f.push("missing the button color rgb(110,64,201)");
      // Intra-frame animation keyframes on frame 0, tweening the detected scale.
      if (!/@keyframes f0-/.test(svg)) f.push("missing intra-frame animation keyframes on frame 0 (the synthesized scale tween)");
      if (!/matrix\(1\.08/.test(svg)) f.push("missing the detected hover transform matrix(1.08, …) in the tween keyframes");
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
