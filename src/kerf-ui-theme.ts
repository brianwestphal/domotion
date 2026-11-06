/**
 * Shared `@kerfjs/ui` theme for Domotion's dark-only browser tools: the
 * published svg-review, svg-scrubber and Studio pages, plus the local
 * `demos:review` harness.
 *
 * kerf-ui's foundation declares `:root { color-scheme: light dark }` and
 * resolves its semantic `--kui-color-*` ramps with `light-dark()`. These pages
 * are dark-only, so this pins `color-scheme: dark` (the page stylesheet loads
 * after the package CSS and wins) and maps the base ramps onto the GitHub-dark
 * palette the tools already use. The `*-on-quiet` state colors are overridden
 * too: the package's defaults (#008932 / #a16a00 / #c20b20) are tuned for a
 * light surface and fall below a readable contrast on #161b22.
 *
 * Only public tokens are set — never kerf-ui's private descendant rules — so a
 * package upgrade keeps this valid (kerf-ui skill rule 5).
 */
export const KERF_UI_DARK_THEME_CSS = `
:root {
  color-scheme: dark;
  --kui-color-surface: #161b22;
  --kui-color-surface-lowered: #0d1117;
  --kui-color-text: #e6edf3;
  --kui-color-text-quiet: #8b949e;
  --kui-color-text-link: #58a6ff;
  --kui-color-neutral-fill-normal: #21262d;
  --kui-color-neutral-fill-loud: #6e7681;
  --kui-color-neutral-border-normal: #30363d;
  --kui-color-neutral-border-loud: #484f58;
  --kui-color-brand-fill-loud: #58a6ff;
  --kui-color-brand-on-quiet: #79c0ff;
  --kui-color-success-fill-loud: #2ea043;
  --kui-color-success-on-quiet: #56d364;
  --kui-color-warning-fill-loud: #d29922;
  --kui-color-warning-on-quiet: #e3b341;
  --kui-color-danger-fill-loud: #f85149;
  --kui-color-danger-on-quiet: #ffa198;
}
`;
