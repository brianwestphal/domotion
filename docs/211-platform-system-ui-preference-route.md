---
id: "requirements/platform-system-ui-preference-route"
title: "Platform-owned system-ui preference route"
kind: "reference"
status: "current"
owners: ["platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2351","DM-2504"]
code: [".github/workflows/system-ui-preference-route.yml","src/render/glyph-helper.ts"]
aliases: ["docs/211-platform-system-ui-preference-route.md","doc-211"]
---

# Platform-owned `system-ui` preference route

**Status:** shipped logical oracle (DM-2504).
**Gate:** `npm run fonts:system-ui-preferences`.
**Workflow:** `.github/workflows/system-ui-preference-route.yml`.

## Boundary

CSS `system-ui` is not a generic-family-settings entry. DM-2351 therefore used
it only to prove that `Page.setFontFamilies` did **not** affect the platform UI
route; those stable rows were never evidence that Domotion selected the same UI
face. This oracle owns that missing boundary separately.

The verdict is exact logical identity. For each style, Chromium reports the
painted family and PostScript name through
`CSS.getPlatformFontsForNode`. Domotion asks its live native platform route and
the two sides join on normalized PostScript name when both have one, otherwise
on the explicitly reported family name. There are no screenshots, raster
tolerances, committed expected-face snapshots, or OS-name lookup tables.
Inventory, OS, browser, Node, Chromium, Skia, and HarfBuzz fingerprints travel
with every report.

## Pinned source routes

The local Chromium checkout is pinned at `7d859f27`.

- **macOS.** `FontCache::CreateFontPlatformData` intercepts the exact
  `system-ui` name and calls `MatchSystemUIFont`
  (`font_cache_mac.mm:405-415`). The matcher begins with
  `CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr)`, applies
  italic/bold symbolic traits, then clamps and applies CSS `wght` / `wdth`
  coordinates (`font_matcher_mac.mm:540-586`). The Domotion CoreText helper
  already carries that transcription; its `meta` response now exposes the
  opened family, PostScript name, and current CoreText coordinates. The oracle
  crosses 13/20 px, light/bold, italic, condensed, and expanded requests.
- **Linux.** The browser supplies `RendererPreferences.system_font_family_name`.
  `RenderViewHostImpl::GetPlatformSpecificPrefs` prefers
  `--system-font-family` and otherwise uses `gfx::Font().GetFontName()`
  (`render_view_host_impl.cc:268-277`). Blink stores it in
  `FontCache::SetSystemFontFamily`; `system-ui` then resolves that concrete
  family through normal platform font data (`font_cache.cc:139-166`,
  `font_cache_linux.cc:37-51`). The oracle derives two distinct installed
  families from live `fc-match` answers, launches each browser with the matching
  switch, and asks Domotion's transcribed Skia/fontconfig cut matcher the same
  renderer-family question. The selected face must move and both states must
  agree exactly.
- **Windows.** The browser obtains the menu font from
  `gfx::win::GetSystemFont(kMenu)`
  (`render_view_host_impl.cc:136-145,248-267`). `ui/gfx/system_fonts_win.cc`
  initializes that value from `NONCLIENTMETRICS.lfMenuFont` via
  `SPI_GETNONCLIENTMETRICS` (`:140-205`), and Blink exposes it as
  `FontCache::SystemFontFamily()` (`font_cache_skia_win.cc:124-142`). The oracle
  derives an alternate installed family from the live browser, changes only the
  current user's menu-font family with `SPI_SETNONCLIENTMETRICS`, launches a new
  browser, and restores the original family in `finally`. It also proves the
  warm Domotion memo remains old before environment invalidation and moves only
  after `invalidateFontEnvironmentCaches()`.

## Production seam and cache lifetime

`resolveSystemUiFontFace()` in `src/render/glyph-helper.ts` is the shared exact
logical question:

- CoreText UI-font handle on macOS;
- browser-owned renderer family through the Linux fontconfig matcher;
- live menu family followed by DirectWrite style matching on Windows.

The renderer's existing ordinary Linux route still starts from the
source-defined `sans` fallback when no browser preference value is supplied.
The oracle passes the controlled renderer value explicitly; it does not pretend
that `Page.setFontFamilies` owns this path.

The Windows menu family was process-memoized but omitted from
`clearGlyphHelperCache()`. That contradicted
`invalidateFontEnvironmentCaches()`'s contract to observe preference-generation
changes. DM-2504 clears the memo at that boundary and pins the postcondition in
`font-resolution-cache-reset.test.ts`.

## Activation and negative controls

Every launch reads browser rows twice and requires identical face/glyph-count
answers. A separately created Page receives a dynamically derived
`Page.setFontFamilies` mutation; every `system-ui` row must remain stable. This
is only an ownership negative control, not a parity inference.

The positive activation differs by platform:

- macOS must expose multiple CoreText UI identities across the style/metric
  matrix;
- Linux's two renderer-family preferences must select different faces;
- Windows's menu-family mutation must change both the new browser and the
  invalidated Domotion route, while the deliberately stale pre-invalidation
  lookup retains the old family.

The workflow runs Playwright's pinned Chromium and installed full Chrome,
headless and headed, on macOS, Linux (headed under Xvfb), and Windows. It builds
the native helper from the checked-in source on every platform and uploads the
logical report even when a leg fails. Windows mutation requires the explicit
`--allow-system-preference-mutation` flag and always restores the original menu
font.

## Representative local evidence

On macOS 26.5, pinned Chromium `147.0.7727.15` produced a source-exact 7/7
focused result: `.SFNS-Regular`, `.SFNS-Bold`, and `.SFNS-RegularItalic` all
joined the independently queried CoreText UI handle, repeat reads were stable,
and the dynamically chosen Times generic-map mutation left all `system-ui` rows
unchanged. The report carried font-inventory digest `25ffa1f91f5e6f79`; that
digest is evidence for this machine, not an answer snapshot for another one.
