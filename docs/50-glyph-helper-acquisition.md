---
id: "requirements/glyph-helper-acquisition"
title: "Domotion: on-demand native glyph-helper acquisition"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-K85TST", "DM-2353", "DM-2664", "DM-393", "DM-881", "DM-886", "DM-887", "DM-890"]
code:
  [
    ".github/workflows/release-helpers.yml",
    ".github/workflows/release.yml",
    "packages/text-engine/src/render/glyph-helper.ts",
    "packages/text-engine/src/render/glyph-helper-transport.ts",
    "packages/text-engine/src/render/helper-acquire.ts",
    "tests/release-helpers-workflow.test.ts",
  ]
aliases: ["docs/50-glyph-helper-acquisition.md", "doc-50"]
---

# Domotion: on-demand native glyph-helper acquisition

Requirements for fetching the platform's native glyph-extractor binary (the
CoreText / FreeType / DirectWrite helpers) from the GitHub release into a
per-user cache at runtime, so a **published-npm consumer** has a working helper
without it being committed to git or bundled in the tarball. Origin: DM-886
(the missing DM-393 layer, discovered during DM-881 — see `docs/49`).

> **Status: IMPLEMENTED (DM-886).** `packages/text-engine/src/render/helper-acquire.ts` ships the
> acquisition layer, wired into the helper transport's resolver (`glyph-helper-transport.ts`, behind the `glyph-helper.ts` facade) as the third source.
> The maintainer's decisions are recorded in [Decisions](#decisions-adopted).
> This is piece **B** of the DM-881 split; piece A (platform-aware resolution in
> `glyph-helper.ts`) is the consumer of this layer.

## The gap

`isGlyphHelperAvailable()` (DM-881) resolves a helper binary from, in order:
`DOMOTION_HELPER_PATH` → the in-tree `tools/<platform>-glyph-extractor/` build.
But the published package carries no built helper binary: at the time `tools/` was not in the published npm `files` (`["dist", …]`), and today the bundled `@domotion/text-engine` workspace ships `tools/` only for the helper _sources_ — built binaries are gitignored per helper directory and kept out of the tarball (doc 46, `npm run check:pack-contents`). So for a
consumer who ran `npm install domotion`, neither path yields a binary → the helper is
unavailable on **every** platform (macOS included) and the renderer falls back
to fontkit. The helpers therefore only work in in-repo dev or when a consumer
manually points `DOMOTION_HELPER_PATH` at a binary they built themselves.

This layer closes that gap: download the right release asset on demand, verify
it, cache it, and reuse it — adding a third resolution source ahead of the
(consumer-absent) in-tree path.

## The release-asset contract (already in place)

`.github/workflows/release-helpers.yml` builds and attaches, to the GitHub
release for the explicit `vX.Y.Z` tag supplied by the caller (repo
`brianwestphal/domotion`):

| Platform | Asset name                                   | Sidecar     | Arch coverage                                      |
| -------- | -------------------------------------------- | ----------- | -------------------------------------------------- |
| macOS    | `domotion-glyph-paths-darwin-universal`      | `…​.sha256` | universal (arm64 + x86_64), codesigned + notarized |
| Linux    | `domotion-glyph-paths-linux-{x64,arm64}`     | `…​.sha256` | x86_64 + arm64                                     |
| Windows  | `domotion-glyph-paths-win32-{x64,arm64}.exe` | `…​.sha256` | x86_64 + arm64                                     |

Each `.sha256` sidecar is the `shasum -a 256` / `sha256sum` output (hex digest +
filename). The asset is keyed to the package version via the release tag.

The release workflow invokes the helper workflow only after GitHub Release
creation succeeds. A source-resolution job checks that the selected source's
`package.json` version matches the target tag (without its `v` prefix), resolves
one full commit SHA, and requires the target release to exist before native
builds or signing begin. Every native job checks out that same immutable SHA.
By default, both reusable and manual runs select the requested tag. The sole
compatibility exception is the existing default-tag `vX.Y.Z-beta.N` flow:
`release.yml` applies the beta npm version ephemerally, so that tag may contain
source package version `X.Y.Z`. This exception never applies to an explicit
`source_ref` refresh, even when it names the tag itself.

All five native jobs retain their staged binary and sidecar as seven-day
Actions artifacts. One fan-in job verifies that the complete five-platform set
is present, every binary agrees with its named checksum sidecar, and retained
source provenance matches the pinned commit/package version. Only then does it
attach assets to the existing release. The macOS signing, notarization and
signature verification stages remain required. Both Linux builds install
FreeType and Fontconfig development headers.

The release also receives `domotion-helper-provenance.json` and its SHA-256
sidecar. It records the target tag, requested source ref, resolved commit,
actual source package version, target version, compatibility policy, workflow/run identity and each binary's checksum/size. The
resolved source record and verified aggregate record are retained separately as
Actions artifacts. There is no parallel tag trigger or polling window; a
transient attach failure can be retried without repeating native
builds/signing (DM-2664).

### Refresh helpers without a new npm release (DM-K85TST)

For a reviewed same-version native fix, manual dispatch accepts `source_ref`:

```bash
gh workflow run release-helpers.yml --ref main \
  -f tag=v0.35.0 -f source_ref=<reviewed-full-commit-sha>
```

The workflow definition must already be integrated. `source_ref` may be a ref
or commit; it is resolved once before all five builds, so a moving branch
cannot split their source versions. Omitting it retains the tag source. A
source with a different package version fails before any native build. This
path only replaces helper assets on the existing release: it does not move the
tag, create a release or publish npm.

After publication, verify a clean-cache download of the macOS helper reports
`ctCapHeight` and `ctXHeight`, and run the SVG root Chromium metric tests without
skips. A coordinated refresh containing Linux/Windows metadata changes also
needs their target-platform probes. Retained producer checksums and successful
signing are build evidence; fetched-asset metadata and actual Chromium parity
are separate consumer evidence. Existing cached older helpers retain their
compatible fallback behavior until replaced; a helper refresh does not
silently invalidate every consumer's versioned cache.

> **Current Linux arm64 contract (DM-2353):** v0.24.0 carries the native glyph
> asset + sidecar and `icu-v78.2-domotion.1` carries the arm64 executable/data +
> sidecars. Doc 196 pins their digests and adds a clean-cache native consumer
> workflow. The pre-gate release audit found zero downloads, so the first
> post-integration `exact-arm64-release-parity` artifact—not the producer build
> alone—is the live consumer proof.

## Proposed design

A self-contained `acquireGlyphHelper()` module (e.g. `packages/text-engine/src/render/helper-acquire.ts`),
called by `glyph-helper.ts`'s resolution as the source _after_ the in-tree path:

1. **Resolve the target.** Asset name from the table above by `process.platform`
   - `process.arch` (darwin universal, linux/win32 × x64/arm64); bail (→ fontkit)
     on a combination with no asset.
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

| Platform | Directory                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Linux    | `$XDG_DATA_HOME/domotion/<version>/bin/` (default `~/.local/share/domotion/<version>/bin/`)               |
| Windows  | `%LOCALAPPDATA%\domotion\<version>\bin\`                                                                  |
| macOS    | `~/Library/Caches/domotion/<version>/bin/` **or** `~/Library/Application Support/…` — see open decision 5 |

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

**Recovery.** The synchronous render-path download is attempted at most once per
process. If it failed and a later `acquireGlyphHelper()` succeeds, that success is
treated as a font-environment change: the sync failure latch and the transport's
memoized "unavailable" are cleared and `invalidateFontEnvironmentCaches()` runs,
so the next lookup uses the native helper and no answer computed in degraded mode
survives. The ICU companion (`acquireIcuCompanion()`) follows the same rule. An
ordinary pre-warm (no earlier failure) invalidates nothing. Because the
invalidation also drops `local()` font aliases, a caller that recovers in the
middle of a capture session must re-register them; a capture re-registers them
on its next run.

**Cold ICU acquisition (DM-T9Z4HF).** The independently versioned ICU
companion verifies the SHA-256 sidecar for every executable, data file, and
required Windows runtime library before installing the executable. Each asset
has a 30-second request deadline and at most three attempts, with short bounded
backoff for connection errors, request timeouts, HTTP 408/429, and server errors.
Missing assets or checksum failures do not retry. Requests and backoff share a
55-second acquisition budget; the synchronous download worker retains its
60-second deadline. Terminal download diagnostics name the
release and asset, HTTP stage/status or checksum mismatch, and any transport
cause; worker failures retain child diagnostics and identify worker timeouts.
Acquisition failure still falls back to the prior companion release and then
warns once before using best-effort JavaScript classification.

`npm run fonts:prewarm-icu` builds the text-engine workspace, acquires the
preferred ICU release, and validates a real versioned-protocol Latin query. It
fails explicitly if only the legacy companion is available or the native query
fails. The primary macOS CI test job runs it serially before Vitest forks, so
parallel workers reuse a validated cache instead of racing cold downloads. This
strict CI gate does not remove the normal consumer's degraded runtime path.

**Persistent-channel crashes.** The helper normally runs as one persistent
`--serve` child. If its first round trip fails, the binary is taken not to
support the channel and every later call uses one-shot spawns. If it worked and
then crashed, the next call respawns it, but only
`MAX_CONSECUTIVE_PERSISTENT_CRASHES` (3) times in a row without an intervening
success. After that the channel is disabled until the next
`invalidateFontEnvironmentCaches()`. Each failed persistent call is still
answered by a one-shot spawn, so this bound changes cost, not answers.

## Decisions (adopted)

The maintainer's calls on the open questions (all implemented):

1. **Download trigger → lazy first-render fetch.** The synchronous resolver in
   `packages/text-engine/src/render/glyph-helper-transport.ts` (`resolveHelperPath`) calls `acquireGlyphHelperSync()` when no `DOMOTION_HELPER_PATH`
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
   for the tag (macOS already did). The arm64 jobs (`ubuntu-22.04-arm` /
   `windows-11-arm`) were validated against the v0.5.0 release (DM-890): both
   runner labels provision, the FreeType/DirectWrite helpers compile on arm64,
   and `acquireGlyphHelper({ arch: "arm64" })` downloads + SHA-verifies both
   assets; the linux-arm64 binary additionally ran natively in an aarch64 Linux
   container and produced correct outlines. (win32-arm64 live execution awaits
   real arm64-Windows hardware — same build path as the validated x64 .exe.)
5. **macOS cache dir → `~/Library/Caches/domotion/<version>/bin/`** (a
   reconstructible artifact; OS-purgeable is fine since it re-downloads).

## Implementation

- **`packages/text-engine/src/render/helper-acquire.ts`** — `assetNameFor`, `cacheDirFor`,
  `parseSha256Sidecar`, `downloadAndInstall` (fetch asset + sidecar →
  SHA-256-verify → atomic temp-write + `chmod 0o755` + rename), the sync
  `acquireGlyphHelperSync` (child-process download, one attempt per process,
  warn-once latch), the async `acquireGlyphHelper`, and a worker entry guarded
  on `argv[1]` so a normal `import` never triggers a download.
- **`packages/text-engine/src/render/glyph-helper-transport.ts`** — `resolveHelperPath` now falls through to
  `acquireGlyphHelperSync({ platform })` after the env override + existing
  in-tree binary.
- **Tested:** unit (asset/cache/sidecar resolvers, unsupported-arch + cache-hit
  offline) + a loopback-HTTP-server exercise of download/verify/install (good /
  bad-SHA / 404). The full sync path was validated end-to-end against the real
  `v0.5.0` darwin release asset (downloads, verifies, installs, the binary runs).
- **Linux arm64 release consumer (DM-2353 / doc 196):** the dispatch-only native
  workflow uses the production async acquisition APIs in a never-used cache,
  requires the pinned digest, sidecar, GitHub digest, ELF architecture and live
  protocols to agree, proves cache reuse, then runs the exact logical and
  selected visual parity matrix. Native run `32689447808` retains the first
  independently hash-verified exact release-consumer artifact (doc 196).

## Relationship to other work

- **DM-881** (landed) — platform-aware resolution; this layer plugs in as the
  third resolution source. `docs/49`.
- **DM-393 / doc 16** — the original acquisition design this implements.
- **DM-887** — the probe-then-fallback trigger; independent of acquisition.
