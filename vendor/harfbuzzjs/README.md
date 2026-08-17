# Vendored harfbuzzjs — built with Chromium's HarfBuzz configuration

This is [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs) **v1.4.0**, with
`dist/harfbuzz.js` and `dist/harfbuzz.wasm` rebuilt from source using the
HarfBuzz build configuration **Chromium ships**, rather than the `-DHB_TINY`
configuration the published package uses.

`harfbuzz-subset.wasm` is rebuilt from v1.4.0 with CFF subsetting restored; the
published `HB_TINY` option closure otherwise re-disables CFF after the override
header runs. `harfbuzz.d.ts` remains the published artifact, unmodified.
`index.mjs` and `index.d.mts` carry **one local addition**, marked
inline as `LOCAL ADDITION`: a `Font.setPtem()` method. Preserve it across any
re-vendor — the diff is four lines mirroring the adjacent `setScale`, and
losing it silently disables AAT tracking rather than failing.

`build/harfbuzz.symbols` is likewise harfbuzzjs's with one line added
(`_hb_font_set_ptem`); the upstream build does not export it. Copy that file
into the clone alongside `config-override.h` and the `Makefile`.

Why `ptem` is needed: HarfBuzz reads the AAT `trak` tracking amount from the
font's nominal point size, and Blink sets it on every shaped run for exactly
that reason (`platform/fonts/shaping/harfbuzz_face.cc:641-647` — "Setting ptem
here is critical for HarfBuzz to know where to lookup spacing offset in the AAT
trak table"). With `ptem` left at 0, no tracking is applied at all, which on
macOS is a different answer from Chrome's for Helvetica, Times, SF Pro and every
PingFang cut.

## Why

Domotion's goal in the font area is that glyph selection and positioning follow
the same decision procedure Chromium follows. Shaping is delegated by Blink to
HarfBuzz on every platform, so "the same procedure" means the same HarfBuzz,
built the same way.

The published harfbuzzjs is built `-DHB_TINY`, which compiles out a lot,
including **all Apple Advanced Typography support**. That matters on macOS,
where Apple ships system faces carrying a `morx` table and no `GSUB` at all —
GeezaPro (Arabic), Helvetica, Al Nile, Baghdad. HarfBuzz applies `morx` based
on the *face*, not the script, ignoring `GSUB` even when present
(`_hb_apply_morx`, `hb-ot-shape.cc:60-65`), so on those faces a `HB_TINY` build
does not shape the same text the same way. Measured on GeezaPro, one Arabic
word, advances in font units:

```
hb-shape 14.x, and Chrome    647  656 1359  700  971
harfbuzzjs as published      647 1415 1292  902  900
```

The second row is the isolated forms — no joining, because the only table that
could have joined them was compiled out. Chromium's own `README.chromium` for
HarfBuzz is explicit about relying on this: *"we are not building hb-coretext
any longer, as we rely on HarfBuzz' built-in AAT shaping."*

Rebuilt with Chromium's configuration, both an AAT-only face and a `GSUB` face
reproduce `hb-shape` exactly:

```
GeezaPro (morx, no GSUB)   647 656 1359 700 971
Arial Unicode (GSUB)       559 498 1323 893 985
```

The `-DHB_TINY` chain also removed HarfBuzz's two font blocklists, its legacy
cmap subtables, the OT shaper's Arabic/Hebrew/Thai fallback paths, and its
vowel-constraint handling. Chromium keeps all of those. Package size is not a
constraint here — Domotion already bundles Chromium.

## Provenance

| | |
| --- | --- |
| harfbuzzjs | v1.4.0 (`e55f3ce`) |
| HarfBuzz | 14.2.1 (submodule `56feae4`, 2026-06-02) |
| Chromium's HarfBuzz | 14.2.1 (`511df88b`, 2026-06-23) — **same release** |
| Config transcribed from | `third_party/harfbuzz/BUILD.gn:462-518`, Chromium rev `7d859f27` (2026-06-27) |
| Toolchain | `emscripten/emsdk:4.0.13` |

`build/config-override.h` is the configuration itself. It carries Chromium's
define list with Chromium's own comments, plus a section naming every Chromium
define that could **not** be reproduced here and why. `build/Makefile` is
harfbuzzjs's, with `COMMON_CXXFLAGS` reduced to Chromium's set.

Two divergences from Chromium remain and are documented inline in
`build/config-override.h`:

1. **Unicode character properties.** Chromium sources them from ICU
   (`HAVE_ICU` + `HB_NO_UCD`); this build uses HarfBuzz's built-in UCD tables.
   The two agree except where their Unicode versions differ — recently assigned
   codepoints. (Still an improvement: `HB_TINY` additionally set
   `HB_NO_UCD_UNASSIGNED`, so the published build answered from truncated
   tables.)
2. **The Rust shaping backend** (`HAVE_HARFRUST` / `HAVE_FONTATIONS`). Not a
   divergence for shipping Chrome: Blink requests it only under the
   `HarfRustShaping` runtime flag, which is off by default, and otherwise pins
   the `"ot"` shaper explicitly. It becomes one if that flag ever ships enabled.

## Rebuilding

```sh
git clone --recursive -b v1.4.0 https://github.com/harfbuzz/harfbuzzjs
cd harfbuzzjs
cp <this-dir>/build/config-override.h .
cp <this-dir>/build/Makefile .
cp <this-dir>/build/harfbuzz.symbols .
cp <this-dir>/build/config-override-subset.h .
docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:4.0.13 make harfbuzz harfbuzz-subset
cp dist/harfbuzz.js dist/harfbuzz.wasm dist/harfbuzz-subset.wasm <this-dir>/dist/
# then re-apply the setPtem addition to dist/index.mjs and dist/index.d.mts
```

`emsdk:4.0.13` is the version harfbuzzjs's own CI pins; `emsdk:latest` fails on
`-Werror,-Wunused-template` raised by HarfBuzz's pragmas.

**Copy both files together.** Chromium does not define `HB_NO_GETENV`, so
neither does this build, and the module therefore imports `environ_get` /
`environ_sizes_get` from `wasi_snapshot_preview1`. The published glue does not
provide those, so a mismatched pair fails loudly at instantiation with a
`LinkError` rather than shaping incorrectly.

To confirm the toolchain before trusting a result, build the clone
**unmodified** first: it reproduces the published artifacts byte for byte
(sha256 prefixes `64c8f422b7d31120` wasm, `d64d3aecca9424ee` js). Any later
difference is then attributable to the configuration and not to the build
environment.
