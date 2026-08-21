# Font-size space oracle

DM-2448 protects the three font-size spaces introduced by DM-2446. The
Chromium-backed oracle is `tests/font-size-spaces.e2e.test.ts`.

The matrix covers direct and nested `zoom`, direct and nested transforms,
zoom/transform cancellation, mixed factors, `font-optical-sizing:none`, and an
explicit `"opsz"` axis. It records and asserts:

- logical/CSSOM, effective-zoomed computed/match, and final paint sizes;
- canvas metrics at computed size followed only by transform scaling;
- Range origins and captured text/x-offset origins;
- reconstructed baselines;
- CDP platform-face identity across optical-sizing requests; and
- SVG outline-scale ratios in path mode.

The oracle deliberately compares relationships rather than macOS-only names or
font-unit constants, so it can run on every supported platform. Explicit
`opsz` and optical-sizing mode are asserted as capture inputs; axis-coordinate
precedence remains covered by `src/render/axis-location.test.ts`.

Per-segment metrics are part of the contract. Ordinary, first-line, pseudo, and
input segments use their own face/style at computed size, followed by the
transform-only paint scale. Bespoke metrics such as initial-letter synthesis are
preserved when they do not equal the segment's logical-size canvas metric.

Run the oracle with:

```bash
npm run build:capture-script
npx vitest run --config vitest.e2e.config.ts tests/font-size-spaces.e2e.test.ts
```
