# Domotion: on-demand native glyph-helper acquisition

Requirements for fetching the platform's native glyph-extractor binary (the
CoreText / FreeType / DirectWrite helpers) from the GitHub release into a
per-user cache at runtime, so a **published-npm consumer** has a working helper
without it being committed to git or bundled in the tarball. Origin: DM-886
(the missing DM-393 layer, discovered during DM-881 — see `docs/49`).

> **Status: IMPLEMENTED (DM-886).** `src/render/helper-acquire.ts` ships the
> acquisition layer, wired into `glyph-helper.ts`'s resolver as the third source.
> The maintainer's decisions are recorded in [Decisions](#decisions-adopted).
> This is piece **B** of the DM-881 split; piece A (platform-aware resolution in
> `glyph-helper.ts`) is the consumer of this layer.

## The gap

`isGlyphHelperAvailable()` (DM-881) resolves a helper binary from, in order:
`DOMOTION_HELPER_PATH` → the in-tree `tools/<platform>-glyph-extractor/` build.
But `tools/` is **not** in the published npm `files` (`["dist", …]`), so for a
consumer who ran `npm install domotion`, neither path exists → the helper is
unavailable on **every** platform (macOS included) and the renderer falls back
to fontkit. The helpers therefore only work in in-repo dev or when a consumer
manually points `DOMOTION_HELPER_PATH` at a binary they built themselves.

This layer closes that gap: download the right release asset on demand, verify
it, cache it, and reuse it — adding a third resolution source ahead of the
(consumer-absent) in-tree path.

## The release-asset contract (already in place)

`.github/workflows/release-helpers.yml` builds and attaches, to the GitHub
release for each pushed `vX.Y.Z` tag (repo `brianwestphal/domotion`):

| Platform | Asset name | Sidecar | Arch coverage |
| --- | --- | --- | --- |
| macOS | `domotion-glyph-paths-darwin-universal` | `…​.sha256` | universal (arm64 + x86_64), codesigned + notarized |
| Linux | `domotion-glyph-paths-linux-x64` | `…​.sha256` | x86_64 only |
| Windows | `domotion-glyph-paths-win32-x64.exe` | `…​.sha256` | x86_64 only |

Each `.sha256` sidecar is the `shasum -a 256` / `sha256sum` output (hex digest +
filename). The asset is keyed to the package version via the release tag.

> **Observed gap (2026-05-26):** the `v0.5.0` release currently has **only the
> macOS asset** attached — the Linux/Windows `release-helpers.yml` jobs have not
> uploaded theirs for this tag. So this layer is end-to-end testable on macOS
> today, but Linux/Windows acquisition can't be validated against a real release
> until those jobs run + upload. (See open decision 4.)

## Proposed design

A self-contained `acquireGlyphHelper()` module (e.g. `src/render/helper-acquire.ts`),
called by `glyph-helper.ts`'s resolution as the source *after* the in-tree path:

1. **Resolve the target.** Asset name from the table above by `process.platform`;
   bail (→ fontkit) on an unsupported platform/arch (e.g. linux-arm64).
2. **Check the cache.** Per-platform cache dir, versioned by the installed
   package `version` (so a Domotion upgrade fetches a fresh binary and old
   versions keep their own). If a verified binary is already cached, reuse it.
3. **Download** the asset + its `.sha256` sidecar from the release for the
   matching tag.
4. **Verify** the SHA-256 against the sidecar; on mismatch, discard + treat as a
   failed acquisition.
5. **Install** into the cache: write atomically (temp + rename), `chmod 0o755`
   on POSIX.
6. **Reuse** thereafter; the in-memory availability cache in `glyph-helper.ts`
   already memoizes per process.

### Cache locations

| Platform | Directory |
| --- | --- |
| Linux | `$XDG_DATA_HOME/domotion/<version>/bin/` (default `~/.local/share/domotion/<version>/bin/`) |
| Windows | `%LOCALAPPDATA%\domotion\<version>\bin\` |
| macOS | `~/Library/Caches/domotion/<version>/bin/` **or** `~/Library/Application Support/…` — see open decision 5 |

### Integrity & safety

- SHA-256 verification against the sidecar is mandatory; a mismatch fails the
  acquisition (never executes an unverified binary).
- Transport is HTTPS to `github.com` release URLs; the sidecar travels the same
  channel (trust-on-first-use against the release). Sufficient for v1; a
  detached signature / pinned key is out of scope.
- Atomic install avoids a torn binary if two processes race.

### Failure / offline policy

Any failure — offline, 404 (asset missing for this version), SHA mismatch,
unsupported arch, unwritable cache — resolves to **helper-unavailable**, i.e.
the exact fontkit fall-through that exists today for a missing helper. Acquisition
never throws into the render path. A single concise warning (once per process)
explains why the native helper was skipped. `DOMOTION_DISABLE_HELPER` short-circuits
acquisition entirely; `DOMOTION_HELPER_PATH` still overrides (no download).

## Decisions (adopted)

The maintainer's calls on the open questions (all implemented):

1. **Download trigger → lazy first-render fetch.** The synchronous resolver in
   `glyph-helper.ts` calls `acquireGlyphHelperSync()` when no `DOMOTION_HELPER_PATH`
   / in-tree binary is found; the download runs in a short-lived child `node`
   process (this module re-invoked as a script) so the otherwise-synchronous
   render path blocks on it exactly once, then caches + reuses. No install-time
   network — `npm ci --ignore-scripts`, offline, and locked-down CI keep
   working. The async **`acquireGlyphHelper()` is exported** (from the package
   barrel) so consumers can pre-warm the cache instead of paying the first-render
   download.
2. **arch coverage → include arm64.** `assetNameFor` resolves
   `linux-arm64` / `win32-arm64` in addition to `linux-x64` / `win32-x64` and the
   macOS universal binary. The release workflow grows arm64 build+upload jobs
   (below); until those assets ship a 404 just falls back to fontkit.
3. **Failure verbosity → warn once per process** on any skipped/failed
   acquisition (offline / 404 / SHA mismatch / unsupported arch), then fontkit.
4. **Release assets → wired in DM-886.** `release-helpers.yml` is extended so
   the Linux/Windows (x64 + arm64) jobs build and upload their assets + sidecars
   for the tag (macOS already did). [Note: arm64 build jobs can't be validated
   from this dev box — they run on GitHub arm64 runners.]
5. **macOS cache dir → `~/Library/Caches/domotion/<version>/bin/`** (a
   reconstructible artifact; OS-purgeable is fine since it re-downloads).

## Implementation

- **`src/render/helper-acquire.ts`** — `assetNameFor`, `cacheDirFor`,
  `parseSha256Sidecar`, `downloadAndInstall` (fetch asset + sidecar →
  SHA-256-verify → atomic temp-write + `chmod 0o755` + rename), the sync
  `acquireGlyphHelperSync` (child-process download, one attempt per process,
  warn-once latch), the async `acquireGlyphHelper`, and a worker entry guarded
  on `argv[1]` so a normal `import` never triggers a download.
- **`src/render/glyph-helper.ts`** — `resolveHelperPath` now falls through to
  `acquireGlyphHelperSync({ platform })` after the env override + existing
  in-tree binary.
- **Tested:** unit (asset/cache/sidecar resolvers, unsupported-arch + cache-hit
  offline) + a loopback-HTTP-server exercise of download/verify/install (good /
  bad-SHA / 404). The full sync path was validated end-to-end against the real
  `v0.5.0` darwin release asset (downloads, verifies, installs, the binary runs).

## Relationship to other work

- **DM-881** (landed) — platform-aware resolution; this layer plugs in as the
  third resolution source. `docs/49`.
- **DM-393 / doc 16** — the original acquisition design this implements.
- **DM-887** — the probe-then-fallback trigger; independent of acquisition.
