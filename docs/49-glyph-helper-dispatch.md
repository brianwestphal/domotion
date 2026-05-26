# Domotion: platform-aware glyph-helper dispatch

Requirements for making the renderer actually *invoke* the native glyph
extractors (macOS CoreText, Linux FreeType, Windows DirectWrite) instead of only
the macOS one. Origin: DM-881 (follow-up to DM-385 / DM-872 / DM-837).

> **Status: DRAFT — blocked on a prerequisite + a decision** (see below). The
> investigation found that the premise of DM-881 ("extends DM-393's acquisition
> which the macOS asset already uses") does **not** hold in the code today.

## Current state (verified)

`src/render/coretext.ts` resolves the helper binary as:

```ts
const HELPER_PATH = process.env.DOMOTION_HELPER_PATH
  ?? path.resolve(HERE, "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths");
```

and `isCoretextHelperAvailable()` returns false unless `process.platform === "darwin"`
**and** that path exists. Two consequences:

1. **There is no on-demand release-asset download anywhere** (`grep` across
   `src/`/`scripts/` for the asset names / a cache dir / a downloader finds
   nothing). DM-393's "download the release asset into the user cache, chmod,
   SHA-verify, reuse" acquisition layer was **never built**. The macOS helper
   does not use it — it uses the in-tree `tools/` binary or `DOMOTION_HELPER_PATH`.
2. **`tools/` is not in the published `files`** (`["dist", …]`). So a
   published-npm consumer has no helper binary on *any* platform, and no way to
   acquire one. `isCoretextHelperAvailable()` is therefore false for every
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
disables. The IPC envelope + `parseSvgPath` + the `createCoretextFont` wrapper
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
