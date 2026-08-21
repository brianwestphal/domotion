# Shaped-origin provenance oracle

DM-2445 adds `npm run fonts:shaped-origin`, a production-path logical oracle
for the `text-small` record fixed by DM-2444.

The oracle captures the real Chromium fixture, enables the existing text-run
provenance stream, renders through SVG paths, and joins the two evidence sets.
Each glyph row records:

- captured post-spacing cluster origin;
- HarfBuzz cluster, advance, and x/y offsets;
- emitted cluster/glyph origin;
- selected face, source member, axis state, and source-file digest; and
- the final snapped baseline.

It also applies a mandatory mutation: captured cluster anchors are collapsed
back to cumulative raw shaping advances. The last glyph must move by at least
one pixel. On the pinned macOS record the mutation moves it by
`-4.94775390625px`, independently recovering the missing 0.55px spacing across
nine boundaries that caused DM-2329.

The assertions are platform-independent. Platform visual envelopes remain
separate terminal-raster evidence: region count must remain zero, while raw
`diffPct` is recorded independently for macOS, Linux, and Windows rather than
treated as a logical tolerance.

The same commit was rerun through all three pinned CI feature pipelines:

| Platform | Run | `regionCount` | `diffPct` | non-AA pixels |
| --- | ---: | ---: | ---: | ---: |
| macOS | `32460833804` | 0 | 0.0035733121927208514 | 39 |
| Linux | `32460836438` | 0 | 0.047651018887152084 | 471 |
| Windows | `32460838994` | 0 | 0.08174824177372704 | 683 |

All three target feature suites and baseline gates passed. The Linux and
macOS workflows subsequently reported unrelated broad-suite failures (host
font assumptions and existing browser E2E records); those later failures do
not alter the recorded target artifacts above.

The oracle pins Chromium `7d859f271c`, HarfBuzz `4de187d`, and Chromium's Skia
`62efacd3`. Run it with:

```bash
npm run fonts:shaped-origin
```
