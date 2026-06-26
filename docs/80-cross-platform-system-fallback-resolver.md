# 80 — Cross-platform live system-fallback resolver

Status: **macOS shipped** (CoreText, DM-1018) · **Linux shipped, opt-in** (fontconfig, DM-1403) · **Windows: design only** (DirectWrite, DM-1403 follow-up).

Related: [42 — cross-platform fallback-chain calibration](42-cross-platform-fallback-calibration.md).

## Problem

Domotion routes a codepoint to a fallback font through a **static, generated
per-block table** (`FONT_PATHS` / `LINUX_FONT_PATHS` / `WIN32_FONT_PATHS` in
`src/render/font-resolution.ts`). The table is necessarily incomplete: a
codepoint it misses drops to `LastResort` — i.e. renders as **tofu** — even when
the host actually has a font that covers it and the browser would have painted a
real glyph.

macOS already closes that gap with a **live, per-codepoint resolver**:
`resolveSystemFallbackKeyForCp(cp)` asks CoreText (`CTFontCreateForString`, via
the native Swift helper) which on-disk font it would pick for `cp`, registers
that face under a dynamic `sysfb:<postscriptName>` key
(`registerDynamicSystemFont`), and returns the key so the normal chain walker
opens it. Each first-seen codepoint costs one resolution; results are memoized.

Linux and Windows had no equivalent — the resolver was hard-gated
`process.platform !== "darwin" → null`. So on those platforms an
out-of-table codepoint always tofu'd, regardless of what the system could paint.

## Design — symmetric per-platform backend behind one entry point

`resolveSystemFallbackKeyForCp(cp)` is the single entry point. It memoizes per
codepoint, then dispatches by platform:

| Platform | Backend | Status |
|---|---|---|
| macOS | CoreText `CTFontCreateForString` (native helper) | shipped, always on |
| Linux | fontconfig `fc-match :charset=<hex>` | shipped, **opt-in** |
| Windows | DirectWrite `IDWriteFontFallback::MapCharacters` | design only |

Each backend resolves `cp` → an on-disk font, registers it as a `sysfb:<name>`
key, and returns the key. The chain walker is unchanged: it tries the key and
keeps it only if the opened font actually has a glyph for `cp`
(`glyphForCodePoint(cp).id !== 0`) — so a backend that returns a non-covering
face is harmless (it falls through to tofu exactly as before, never a *wrong*
glyph).

### Linux (shipped, opt-in) — `resolveLinuxSystemFallbackKeyForCp`

Uses the established `fc-match` path (the same `fcMatch()` helper the Linux
static table already uses for path discovery — no new native code):

```
fc-match -f '%{file}\t%{postscriptname}' ':charset=<hex>'
```

fontconfig returns the best-priority installed font whose charset covers `cp`.
The face is registered with `extractor: "fontkit"` (the Linux chain's default
extraction), not the darwin `"native"` extractor. Verified against the
Playwright `*-noble` image (`scripts/test-linux-docker.sh`): every script
resolves to a real face — CJK→WenQuanYi Zen Hei, Devanagari→FreeSans,
Arabic→FreeSerif, Thai→Loma — rather than tofu.

**Gated behind `DOMOTION_SYSTEM_FALLBACK`** (off by default). Rationale: turning
it on changes rendering for currently-tofu codepoints, which would shift the
committed Linux CI baselines. It ships off so it lands with **zero baseline
churn**; flip it on as part of the calibration follow-up below.

### Windows (design only) — DirectWrite

`IDWriteFontFallback::MapCharacters(analysisSource, …)` returns the substitute
font DirectWrite would map a run to — the API the browser itself uses. This
needs a native call from the existing `tools/win32-glyph-extractor` (DirectWrite
already), exposed over the glyph-helper protocol like the macOS path, then wired
into `resolveSystemFallbackKeyForCp` under `process.platform === "win32"`.
Tracked as a DM-1403 follow-up; develop on the Parallels Windows 11 VM.

## Calibration caveat (why Linux is opt-in)

`fc-match :charset` answers "a font that covers `cp`", **not** "the font
Chromium-on-Linux would actually pick". Fidelity (doc 01) requires matching
Chromium's choice, so before the flag flips default-on the resolver's picks must
be calibrated against Chromium-on-Linux painted output for the affected blocks
(the same probe-and-match method doc 42 uses for the static chains), and the
Linux/Windows CI baselines re-seeded. Until then the static table remains the
calibrated source of truth and the live resolver is an opt-in safety net for
tofu codepoints.

## Testing

- `__resolveSystemFallbackKeyForCpForTest(cp)` (test-only export) drives the
  resolver directly, honoring the platform routing + the opt-in flag, so a
  Docker/Parallels probe can exercise it end to end.
- macOS path + the chain walker: existing `src/render/*.test.ts` (unchanged —
  Linux is opt-in/off so the suite's behavior is identical).
- Linux: `fc-match :charset` coverage confirmed in the noble image; per-block
  Chromium-paint calibration is the follow-up.

## Code

- `src/render/font-resolution.ts` — `resolveSystemFallbackKeyForCp` (dispatch),
  `resolveLinuxSystemFallbackKeyForCp` (fontconfig), `registerDynamicSystemFont`
  (now takes the extractor), `fcMatch` (the `fc-match` primitive).
