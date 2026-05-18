# Domotion

DOM-to-animated-SVG renderer. Captures HTML/CSS rendered in headless Chromium and converts the captured tree into a self-contained SVG with optional CSS animations — pixel-faithful to what Chromium painted, scales crisply at any size, and embeds without external assets.

## Why

Animated demos for product marketing and documentation usually mean either:

- A bundle of MP4s — heavy, hard to scale, no inline embedding.
- A live iframe — slow, requires the source app to be online, breaks accessibility.
- Hand-authored SVG animations — accurate but enormously time-consuming for anything beyond a couple of frames.

Domotion captures real HTML/CSS as it renders in Chromium, then emits a single inline-embeddable SVG that replays the same pixels with CSS keyframe transitions. Author the demo as plain HTML/CSS in your real app, capture frames, and ship the result as a `<img src="demo.svg">` that loads lazily and scales without artifacts.

## Status

Early — extracted in 2026-04 from the slicekit project where it had been incubating as `tools/svg-demo-gen`. APIs may still shift while the project's external surface stabilizes.

## Platform support

Domotion ships as a normal npm package and is **designed** to work on macOS, Linux, and Windows — the captured SVG is meant to be pixel-faithful to Chromium on whichever platform the capture is running on (CoreText fallback on macOS, fontconfig on Linux, DirectWrite on Windows).

**Today it's only actively tested and calibrated on macOS.** Linux and Windows are roadmap items: cross-platform system-font path discovery, per-platform fallback-font chains calibrated against the host Chromium, optional bundled fallback fonts when no local match resolves, and CI coverage on both platforms. The package will install and run on Linux/Windows, but text rendering won't yet match the host Chromium as faithfully as it does on macOS.

If you'd like to help with cross-platform support — testing on Linux or Windows, reporting issues you hit, or sending fixes — please open an issue or PR on [GitHub](https://github.com/brianwestphal/domotion). Bug reports against macOS are also welcome.

## Install

```bash
npm install domotion-svg
```

That's it — Domotion auto-installs Playwright's Chromium binary on first use
(via `npx playwright install chromium`). On CI you may want to pre-install it
yourself to keep the first job's runtime down.

## Usage

The fastest way in is the `domotion` CLI — no TypeScript, no Playwright bring-up. Point it at a URL or HTML file:

```bash
# Capture a URL as SVG.
domotion capture https://example.com -o example.svg

# Capture a local HTML file at a specific viewport, only the .hero region, optimized.
domotion capture ./demo.html \
  --width 1200 --height 600 \
  --selector ".hero" \
  --optimize \
  -o hero.svg

# Capture HTML piped on stdin.
cat demo.html | domotion capture - -o demo.svg
```

For a multi-frame animated SVG, write a small JSON config and run `domotion animate`:

```bash
domotion animate ./demo.json
```

The config describes each frame (input URL or HTML file, duration, transition, optional pre-capture actions like `click` / `fill` / `scroll` / `hover`). See `domotion --help` for the full grammar and the [Quick start](https://brianwestphal.github.io/domotion/start/quickstart/) for a walkthrough.

### Scripting API

When you outgrow the CLI — custom interaction loops, programmatic frame composition, custom overlays — the same primitives are available as a library:

```ts
import { captureElementTree, elementTreeToSvg, launchChromium, wrapSvg } from "domotion-svg";

const browser = await launchChromium();
const page = await browser.newPage();
await page.setContent(`<div style="padding:20px;color:white;background:#0d1117">Hello</div>`);

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 200 });
const svg = wrapSvg(elementTreeToSvg(tree, 800, 200), 800, 200);

console.log(svg);
await browser.close();
```

For animated demos, capture multiple frames and pass them to `generateAnimatedSvg` (see `examples/`).

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
- `CLAUDE.md` — guidance for AI assistants working in this repo.

## License

[MIT](LICENSE) © Brian Westphal
