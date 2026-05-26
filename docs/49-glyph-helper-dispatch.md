# Domotion: platform-aware glyph-helper dispatch

Requirements for making the renderer actually *invoke* the native glyph
extractors (macOS CoreText, Linux FreeType, Windows DirectWrite) instead of only
the macOS one. Origin: DM-881 (follow-up to DM-385 / DM-872 / DM-837).

> **Status: piece A IMPLEMENTED (DM-881); piece B (acquisition) is DM-886.**
> The investigation found that the premise of DM-881 ("extends DM-393's
> acquisition which the macOS asset already uses") does **not** hold in the code
> today — see "Current state" below. Per the maintainer's decision the work was
> split: **A (platform-aware resolution)** shipped as DM-881; **B (on-demand
> acquisition)** is filed separately as DM-886. See "Implemented (piece A)".

## Current state (verified)

`src/render/coretext.ts` resolves the helper binary as:

```ts
const HELPER_PATH = process.env.DOMOTION_HELPER_PATH
  ?? path.resolve(HERE, "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths");
```

and `isGlyphHelperAvailable()` returns false unless `process.platform === "darwin"`
**and** that path exists. Two consequences:

1. **There is no on-demand release-asset download anywhere** (`grep` across
   `src/`/`scripts/` for the asset names / a cache dir / a downloader finds
   nothing). DM-393's "download the release asset into the user cache, chmod,
   SHA-verify, reuse" acquisition layer was **never built**. The macOS helper
   does not use it — it uses the in-tree `tools/` binary or `DOMOTION_HELPER_PATH`.
2. **`tools/` is not in the published `files`** (`["dist", …]`). So a
   published-npm consumer has no helper binary on *any* platform, and no way to
   acquire one. `isGlyphHelperAvailable()` is therefore false for every
   published consumer; the helper path only runs in in-repo dev (binary built
   locally) or when `DOMOTION_HELPER_PATH` points at a binary.

So "wire the Linux helper in" is really two separable pieces, and the bigger one
(acquisition) is missing for *all* platforms, not just Linux.

## Proposed design

### A. Platform-aware resolution (small, low-risk)

Generalize `coretext.ts` (rename concept: "native glyph helper", not
"coretext") so `isHelperAvailable()` / `HELPER_PATH` dispatch by
`process.platform`:

| Platform | In-tree binary | Asset name |
| --- | --- | --- |
| darwin | `tools/macos-glyph-extractor/domotion-glyph-paths` | `domotion-glyph-paths-darwin-universal` |
| linux | `tools/linux-glyph-extractor/domotion-glyph-paths` | `domotion-glyph-paths-linux-x64` |
| win32 | `tools/win32-glyph-extractor/domotion-glyph-paths.exe` | `domotion-glyph-paths-win32-x64.exe` |

`DOMOTION_HELPER_PATH` overrides on all platforms; `DOMOTION_DISABLE_HELPER`
disables. The IPC envelope + `parseSvgPath` + the `createGlyphHelperFont` wrapper
are already engine-agnostic (the Linux/win32 helpers emit the same design-unit,
y-up JSON), so only the *resolution + platform gate* changes. macOS behavior is
unchanged when the existing path/env logic is preserved.

This makes the Linux/Windows helpers usable **in in-repo dev and via
`DOMOTION_HELPER_PATH`** — enough to wire + test the dispatch — but does nothing
for published consumers without piece B.

### B. On-demand acquisition (the missing DM-393 layer — larger)

Download the platform's release asset into a user cache
(`$XDG_DATA_HOME/domotion/<version>/bin/` on Linux, `%LOCALAPPDATA%\domotion\…`
on Windows, `~/Library/…` on macOS), `chmod +x`, verify the SHA-256 sidecar the
release workflow already uploads, and reuse. This is what makes the helper work
for published consumers on every platform. It's a self-contained module
(`acquireGlyphHelper`) but it's real work (download, cache, integrity, version
pinning, offline/error handling) and it equally benefits macOS — so it's
arguably its own ticket, not "the Linux part of DM-881".

## Open decisions

1. **Split or bundle?** Treat **A** (platform-aware resolution) as DM-881 now,
   and **B** (the DM-393 acquisition layer) as a separate prerequisite ticket
   that lands the auto-download for *all three* platforms? *(recommended — A is
   low-risk and unblocks Linux/win32 dispatch in dev/tests; B is shared work
   that the macOS helper needs too.)*
2. **Is A worth doing before DM-259?** The Linux fallback chain (DM-259) decides
   *which* fonts route through the helper; until it's calibrated the trigger
   fires only for genuine fontkit-can't-extract glyphs (CJK/CFF), which no
   current fixture exercises. So A is correct but low-impact until DM-259.
3. **Naming** — rename `coretext.ts` → `glyph-helper.ts` (engine-agnostic) as
   part of A, or keep the filename and just generalize internals?

## Recommendation

Do **A** (platform-aware resolution + the rename, low-risk, macOS-unchanged) as
DM-881, and file **B** (the cross-platform acquisition layer) as a separate
ticket — it's the real prerequisite for published consumers and benefits macOS
too. Confirm before implementing, since A touches the macOS-working render path.

## Implemented (piece A, DM-881)

`src/render/coretext.ts` now resolves the helper binary **platform-aware**:

- `HELPER_BINARIES` maps `darwin` / `linux` / `win32` to their in-tree
  `tools/<platform>-glyph-extractor/` binary (`.exe` on Windows). The path is
  resolved **two levels up** from the module (`src/render/` → repo root) —
  fixing a latent bug from the DM-619d `src/render/` reorg, where the relative
  path still pointed one level up at a nonexistent `src/tools/`, so even the
  macOS in-tree binary was unreachable except via `DOMOTION_HELPER_PATH`.
- `isGlyphHelperAvailable()` no longer hard-gates on `darwin`; it's available
  whenever a binary resolves for `process.platform`. `DOMOTION_HELPER_PATH`
  overrides on every platform; `DOMOTION_DISABLE_HELPER` disables.
- The IPC wrapper (`createGlyphHelperFont`, `parseSvgPath`, the scale transform in
  `text-to-path.ts`) was already engine-agnostic — all three helpers emit
  design-unit, y-up outlines — so only resolution + the gate changed.

**Naming**: deferred from DM-881 (to keep that diff focused on behavior), then
**done in DM-888** — the module is now `src/render/glyph-helper.ts` and the
symbols are `isGlyphHelperAvailable` / `createGlyphHelperFont` /
`clearGlyphHelperCache` / `GlyphHelperFontInstance`, and the `FONT_PATHS`
`extractor` literal is `"native"`. The historical `coretext.ts` / `Coretext*` /
`extractor: "coretext"` references elsewhere in this doc describe the
pre-DM-888 names.

**What A does NOT do** (deliberately out of scope, follow-ups filed):

- **The probe-then-fallback trigger.** The renderer still routes to the helper
  only via the static `extractor: "coretext"` flag on `FONT_PATHS` entries
  (macOS PingFang only). The doc-16 "fontkit-empty path → consult helper for
  *any* font" trigger is not built, so on Linux/Windows the helper is resolvable
  + invocable but nothing routes through it yet. Filed as a follow-up; pairs
  with the per-platform fallback calibration (DM-259 / DM-260).
- **On-demand acquisition** for published consumers — piece B, now landed in
  DM-886 (`src/render/helper-acquire.ts`; lazy first-render download → user
  cache → SHA-verify → reuse). `glyph-helper.ts`'s resolver falls through to it.

**Tests**: `src/render/glyph-helper.test.ts` gained a platform-agnostic
"platform-aware helper resolution" block (per-platform binary mapping, the
two-levels-up regression assertion, and the `DOMOTION_HELPER_PATH` /
`DOMOTION_DISABLE_HELPER` env behaviors) plus a Linux-gated dispatch test that
spawns the FreeType binary through `createGlyphHelperFont` and extracts an outline
— verified green in the `test:linux-docker` container.

**macOS effect**: fixing the path means the CoreText helper is now actually
reachable in in-repo dev (it was silently unreachable before). PingFang fixtures
now route through CoreText instead of the fontkit/HiraginoSansGB fall-through;
the feature suite stays green (`text-mixed-script` 0.00%; the 3 unrelated
pre-existing border/button/counter failures are unchanged).
