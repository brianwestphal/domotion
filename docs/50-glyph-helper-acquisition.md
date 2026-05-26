# Domotion: on-demand native glyph-helper acquisition

Requirements for fetching the platform's native glyph-extractor binary (the
CoreText / FreeType / DirectWrite helpers) from the GitHub release into a
per-user cache at runtime, so a **published-npm consumer** has a working helper
without it being committed to git or bundled in the tarball. Origin: DM-886
(the missing DM-393 layer, discovered during DM-881 — see `docs/49`).

> **Status: DRAFT — open decisions below (the trigger model is the consequential
> one).** This is piece **B** of the DM-881 split; piece A (platform-aware
> resolution in `src/render/coretext.ts`) has landed and is the consumer of this
> layer.

## The gap

`isCoretextHelperAvailable()` (DM-881) resolves a helper binary from, in order:
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
called by `coretext.ts`'s resolution as the source *after* the in-tree path:

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
6. **Reuse** thereafter; the in-memory availability cache in `coretext.ts`
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

## Open decisions

1. **Download trigger (the consequential one).** When does the fetch happen?
   - **(a) Lazy first-render fetch** *(recommended)* — the first render that
     actually needs the helper triggers the download, caches, reuses. No
     install-time network, so `npm ci --ignore-scripts`, offline/airgapped
     installs, and locked-down CI all keep working; the cost is that the first
     render needing a non-fontkit glyph is slower and needs network once.
   - **(b) `postinstall` script** — download at `npm install` time. Fastest
     first render, but breaks `--ignore-scripts`, offline installs, and trips
     many orgs' "no network in install scripts" security policies. Generally an
     npm anti-pattern.
   - **(c) Explicit opt-in** — a `domotion install-helper` CLI command / exported
     `acquireGlyphHelper()` the consumer runs deliberately. Most predictable, but
     the helper is silently absent until they do.
   - Recommendation: **(a)**, and *also* export `acquireGlyphHelper()` so a
     consumer can pre-warm in CI if they want (a) + (c) without the postinstall
     downside.
2. **arch coverage.** Only x86_64 Linux/Windows assets exist (macOS is
   universal). On linux-arm64 / win32-arm64 there's no asset → silent fontkit
   fallback. OK for v1 *(recommended)*, or is arm64 (build + release jobs)
   in-scope? (Pairs with doc 45 Open-question §3.)
3. **Failure verbosity.** Warn once per process on a skipped/failed acquisition
   *(recommended)*, or stay silent (only surface via a debug flag)?
4. **Linux/Windows release assets aren't attached to v0.5.0.** Acquisition is
   only end-to-end testable on macOS today. Is "make the Linux/Windows
   `release-helpers.yml` jobs actually upload for the current tag" part of
   DM-886, or a separate release-infra ticket? *(recommended: separate — DM-886
   builds + tests the layer on macOS, with Linux/Windows covered by unit tests +
   `DOMOTION_HELPER_PATH` until the assets ship.)*
5. **macOS cache dir.** `~/Library/Caches/…` (doc 16, OS-purgeable — fine since
   re-downloadable) vs `~/Library/Application Support/…` (DM-886 text, persists).
   Recommendation: **Caches** — it's a reconstructible artifact.

## Relationship to other work

- **DM-881** (landed) — platform-aware resolution; this layer plugs in as the
  third resolution source. `docs/49`.
- **DM-393 / doc 16** — the original acquisition design this implements.
- **DM-887** — the probe-then-fallback trigger; independent of acquisition.
