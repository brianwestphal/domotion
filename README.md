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

**Today it's only actively tested and calibrated on macOS.** Linux and Windows are roadmap items: cross-platform path discovery, fallback-font chains, and CI coverage are tracked under DM-258 → DM-259 / DM-260 / DM-261 → DM-262. The package will install and run on Linux/Windows, but text rendering won't yet match the host Chromium as faithfully as it does on macOS.

If you'd like to help with cross-platform support — testing on Linux or Windows, reporting issues you hit, or sending fixes — please open an issue or PR on [GitHub](https://github.com/brianwestphal/domotion). Bug reports against macOS are also welcome.

## Install

```bash
npm install domotion-svg
```

That's it — Domotion auto-installs Playwright's Chromium binary on first use
(via `npx playwright install chromium`). On CI you may want to pre-install it
yourself to keep the first job's runtime down.

## Usage

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
