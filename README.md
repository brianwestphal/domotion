<p align="center">
  <img src="examples/output/domotion-word-demo.svg" alt="Domotion — an animated wordmark cycling through twenty neon-retro typographic variants of the word domotion" width="600">
</p>

<p align="center">
  <strong><a href="https://brianwestphal.github.io/domotion/">🌐 Website &amp; docs</a></strong>
  &nbsp;·&nbsp;
  <a href="https://brianwestphal.github.io/domotion/showcase/">Showcase</a>
  &nbsp;·&nbsp;
  <a href="https://brianwestphal.github.io/domotion/start/quickstart/">Quick start</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/brianwestphal/domotion">GitHub</a>
</p>

**Domotion turns real HTML/CSS into one self-contained, animated SVG** — an accurate reproduction of the rendered page, with optional animation and simulated interaction built in. It embeds the exact captured glyph data and positioning, so playback never falls back to a viewer's system fonts; the output scales crisply at any size and embeds anywhere with a plain `<img>`, no external assets.

Beyond raw capture it ships a **template library** that turns a few flags into a polished animated SVG, **terminal-session capture** (a recording → an animated terminal), **scroll capture** (a long page replayed as one self-contained scrolling SVG), multi-frame **animation** with parameterized and custom transitions, overlays, and simulated interaction, **scene storyboarding** (sequence distinct scenes end-to-end), **brand kits** and **social-format presets** (reel / square / portrait / landscape), **device-chrome** framing, **nested compositing** (animated layers inside animated layers), one-command **SVG → MP4/WebM**, and a fidelity **review** tool.

<p align="center">
  <img src="examples/output/hero-product-demo.svg" alt="An analytics dashboard assembling itself inside a browser window — KPI cards rise in, a bar chart grows with its peak highlighted, a search query types itself, and a nav item is clicked — all in one self-contained animated SVG" width="760">
</p>

<p align="center"><sub>A real UI captured and brought to life — one self-contained SVG. <a href="https://brianwestphal.github.io/domotion/showcase/">More demos →</a></sub></p>

## Why

Animated demos for product marketing and documentation usually mean either:

- A bundle of MP4s — heavy, hard to scale, no inline embedding.
- A live iframe — slow, requires the source app to be online, breaks accessibility.
- Hand-authored SVG animations — accurate but enormously time-consuming for anything beyond a couple of frames.

Domotion captures real HTML/CSS as it renders in Chromium, then emits a single inline-embeddable SVG that replays the same pixels with CSS keyframe transitions. Author the demo as plain HTML/CSS in your real app, capture frames, and ship the result as a `<img src="demo.svg">` that loads lazily and scales without artifacts.

## Status

Actively developed, with a broad shipped surface — capture, multi-frame animation (transitions, overlays, simulated interaction), the template library, terminal capture, nested compositing, and the video/image exports — exercised by an extensive visual-regression suite. The CLIs and the animate-config schema are stable in practice.

## Platform support

Domotion runs on **macOS, Linux, and Windows**, and all three are calibrated. It renders text by extracting the glyphs Chromium selected on the platform you run it on (CoreText on macOS, fontconfig on Linux, DirectWrite on Windows), then embeds those glyphs instead of asking the viewer's machine to perform font fallback. macOS is held to pixel-exact parity; Linux and Windows match Chromium's glyph selection and metrics within a documented native-hinting margin. Linux fidelity is a required CI check; Windows has first-class native validation and release checks, with its slower broad suites dispatched on demand.

Issues, fixes, and platform feedback are welcome on [GitHub](https://github.com/brianwestphal/domotion).

## Quick start

```bash
npm install domotion-svg
npx domotion capture https://example.com -o example.svg
```

Open `example.svg` in a browser. You should see a self-contained, scalable
capture of the page with no external fonts, images, or scripts.

Domotion installs Playwright's Chromium binary on first use. CI jobs can run
`npx playwright install chromium` ahead of time to keep capture runtime
predictable. For a zero-install trial, run
`npx -p domotion-svg domotion capture https://example.com -o example.svg`.

## Choose your task

- **Capture one page:** use `domotion capture`; see the
  [capture guide](https://brianwestphal.github.io/domotion/usage/capture/).
- **Animate a product flow:** use `domotion animate`; follow the
  [animation guide](https://brianwestphal.github.io/domotion/usage/animate/).
- **Generate a polished asset from flags:** use `domotion template`; browse the
  [template guide](https://brianwestphal.github.io/domotion/usage/templates/).

The [Quick start](https://brianwestphal.github.io/domotion/start/quickstart/)
walks through the first capture and animation end to end.

## More capture inputs

After the first capture works, the same CLI accepts local files, stdin, element
selection, custom viewports, optimization, and scrolling pages:

```bash
# Capture one element from a local file at a specific viewport.
domotion capture ./demo.html \
  --width 1200 --height 600 \
  --selector ".hero" \
  --optimize \
  -o hero.svg

# Capture HTML from stdin.
cat demo.html | domotion capture - -o demo.svg

# Capture a long page as one animated scrolling SVG (scrolls to the bottom over 8s).
domotion capture https://example.com --scroll "down:bottom/8s" -o scroll.svg
```

Navigation waits for the page's `load` event, then Domotion applies its normal
font/image/paint readiness checks. Pages with a finite request chain can opt
into Playwright's stricter network-idle heuristic with `--network-idle`; it is
off by default because analytics, long polling, and streaming requests may
never become idle.

Same-origin `<iframe>` content is recursed into the capture as native SVG rather than flattened to a screenshot; opt into cross-origin frames you trust with `--cross-origin-frames "<hosts>"`.

For a multi-frame animated SVG, write a JSON config and run:

```bash
domotion animate ./demo.json
```

The config describes frames, timing, transitions, waits, overlays, and simulated
interaction. See `domotion --help` for the full grammar and the
[animation guide](https://brianwestphal.github.io/domotion/usage/animate/) for
examples ranging from simple transitions to continuous interactive sessions.

Transitions are not limited to fixed presets. Parameterized `push`, `reveal`,
`zoom`, and `shine` forms control direction/angle, distance, origin, radius, and
highlight styling. A strict `custom` recipe can safely combine incoming/outgoing
opacity, translate, scale, reveal clip, and shine channels—plus explicit reduced-
motion and loop behavior—without accepting raw CSS or script.

### Templates — animated SVGs from a few flags

The fastest way to a polished result without writing any HTML. Each built-in is a parameterized generator; pass a few flags and get a self-contained animated SVG. `domotion template list` shows them, `domotion template <name> --help` shows a template's parameters.

```bash
domotion template lower-third --title "Ada Lovelace" --subtitle "First Programmer" -o banner.svg
domotion template chart --type donut --data "42,28,18,12" --labels "Search,Direct,Social,Email" -o chart.svg
domotion template kinetic-text --text "Ship it" --variant pop --by char -o title.svg
```

Built-ins (14): **lower-third** (broadcast banner) · **kinetic-text** (animated typography) · **chart** (column / bar / line / pie / donut) · **chat** (message thread) · **subscribe** (follow pop-up) · **background-loop** (seamless looping background) · **device-mockup** (wrap a page in a phone / browser / window bezel) · and a **creative-template pack** of full-bleed text/number cards: **title-card**, **quote**, **caption**, **cta**, **counter**, **stat**, **compare**. Every template adapts to a `--format` social preset (reel / square / portrait / landscape) and a `--brand` kit (palette / type / logo). Third-party templates are npm packages named `domotion-template-<name>`.

### Terminal sessions

Turn a recorded terminal session into a self-contained animated SVG — real text, real color, native SVG (no raster frames). Record with [asciinema](https://asciinema.org), then convert:

```bash
asciinema rec demo.cast -c "npm test"
domotion term --cast demo.cast -o demo.svg
```

### Compositing — animated layers inside animated layers

`domotion composite` stacks layers — a `cast`, a `template`, or a pre-rendered `svg`, any of which may be animated — into one SVG, each placed and on its own timeline with its animation preserved. This is how you nest one animated thing inside another, e.g. a terminal window resizing on a desktop. See `domotion composite --help` and `examples/composite/`.

### Export to video

The package also ships a standalone `svg-to-video` CLI that renders an animated SVG (a `domotion animate` output, or any CSS-/SMIL-animated SVG) to a video file. It steps the animation timeline frame by frame in Chromium for frame-accurate timing, then pipes the frames to **ffmpeg** (a required external dependency — install via `brew` / `apt` / `winget`).

```bash
# h264/mp4 at 30fps, contained to 1280px wide.
svg-to-video demo.svg -o demo.mp4 --width 1280

# 60fps VP9/webm with looping background music.
svg-to-video demo.svg -o demo.webm --format vp9 --fps 60 --music bed.mp3
```

Supports target size (`--width`/`--height`, aspect-preserving), `--fps`, `--format` / `--container`, supersampling (`--scale`), background music / foreground audio / captions, and a disk-space pre-flight. See `svg-to-video --help`.

### Export to a still image

To turn a single SVG into an image — to look at a render, embed a thumbnail, or hand off a flat asset — the package ships an `svg-to-image` CLI. The output format follows the `-o` extension: PNG / WebP / AVIF / TIFF (keep alpha for transparent SVGs), JPEG (`--quality`), or a single-page vector PDF. (WebP/AVIF/TIFF are transcoded with the bundled `sharp` — no extra install.)

```bash
svg-to-image card.svg -o card.png                 # PNG at the SVG's intrinsic size
svg-to-image card.svg -o card@2x.png --scale 2    # crisp retina (2×) raster
svg-to-image demo.svg -o frame.png --at 4000      # one frame of an animated SVG, at 4s
svg-to-image poster.svg -o poster.pdf             # vector PDF
```

`--at <ms>` samples an animated SVG's timeline, `--width`/`--height` contain preserving aspect, `--scale` supersamples raster output. See `svg-to-image --help`.

### Reviewing a regression

If a capture comes out looking different from how Chromium painted the source page, the package ships an `svg-review` CLI to help you file a focused bug report. Capture once with `--debug` to get a reproduction bundle (HAR + the Chromium screenshot of the source + the SVG we produced), then open the bundle in the local review UI:

```sh
domotion capture https://example.com --debug -o example.svg
svg-review --expected example.debug/expected.png --actual example.debug/actual.svg
```

The browser opens a single review card showing the expected / actual / diff PNGs. Arrow keys cycle through the three at full size; drag on any image to mark a problem region and caption it. The side panel builds a GitHub-issue-ready Markdown block as you go — copy it, then file the issue at <https://github.com/brianwestphal/domotion/issues/new> and attach `expected.png` + `actual.svg` so a maintainer can reproduce.

For automation, pass `--no-open` (or set `DOMOTION_NO_OPEN=1`) and drive the
printed local URL headlessly; Review and Scrubber otherwise open the system
browser for interactive use.

Animation runs have the same evidence path. `domotion animate demo.json --debug`
writes the final `actual.svg`, one shared HAR, and an `expected.png` plus
`captured-tree.json` for each composed frame. Use `--debug-dir <path>` to choose
the bundle location.

For an *animated* SVG, the package also ships `svg-scrubber` — a local video-style bench to play / pause / scrub / mark an in-out range, export the current frame as PNG, export the range as MP4, or trim it to a new self-contained animated SVG. Add `--review` to file a focused issue against a moment in the timeline: it writes an importable `.ticket` (frame time, range, and drawn regions) the same way `svg-review` builds a report for a still.

### Scripting API

When you outgrow the CLI — custom interaction loops, programmatic frame composition, custom overlays — the same primitives are available as a library:

```ts
import { captureElementTree, elementTreeToSvg, launchChromium } from "domotion-svg";

const browser = await launchChromium();
const page = await browser.newPage();
await page.setContent(`<div style="padding:20px;color:white;background:#0d1117">Hello</div>`);

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 200 });
const svg = elementTreeToSvg(tree, 800, 200);

console.log(svg);
await browser.close();
```

For animated demos, capture multiple frames and pass them to `generateAnimatedSvg` (see `examples/`).

Library callers can collect a reproduction entirely in memory with
`captureElementTreeWithDebug()` and `assembleCaptureDebugBundle()`. The caller
keeps ownership of the browser, files, and optional HAR lifecycle; see the
[scripting API](https://brianwestphal.github.io/domotion/developer/api/).

## Scripts

```bash
npm run build           # tsc → dist/
npm test                # unit tests
npm run demos:test      # feature visual-regression suite
npm run demos:test:all  # features + showcase + html-test-suite
npm run demos:review    # local server to compare expected/actual/diff PNGs
npm run demos:examples  # run the bundled example demo scripts
```

## Documentation

- `FEATURES.md` — per-feature support checklist with links to test fixtures.
- `docs/` — requirements docs covering rendering fidelity, supported CSS features, and known caveats.
- [`llms.txt`](llms.txt) — a concise, self-contained guide for **AI agents using Domotion as a tool** (Claude, Cursor, etc.): the CLIs, config schema, template library, API, gotchas, and a required rendered-pixel/video review gate before an SVG is handed back. Point your agent at it.
- `CLAUDE.md` — guidance for AI assistants working *on this repo's* source (different audience from `llms.txt`).

## License

[MIT](LICENSE) © Brian Westphal
