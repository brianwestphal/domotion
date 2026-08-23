# Exact-shaping control fixtures

`TRAK.ttf.base64` is the base64 encoding of
`test/shape/data/in-house/fonts/TRAK.ttf` from HarfBuzz revision
`4de187dd0a915d13c976fa8bd474c084229f3aab` (Git blob
`3be9c0085421079272ddfbffc352862bbf0d0e9b`, SHA-256
`cf3fdeb89ad8e723633fa7f364d0c0097448236884a8299a41a106904c50b7be`).
The font carries the `STAT` and `trak` tables required by HarfBuzz's modern-font
tracking branch and is licensed under the SIL Open Font License 1.1.

The variable-axis row reuses the Open Sans subset embedded in
`../variable-axis/variable-axis.html` and its adjacent license. Both fixtures
are decoded to in-memory HarfBuzz sources; no platform installation or raster
comparison participates in the exact logical gate.

The controls model omission rather than an arbitrary alternate value. Open
Sans is shaped at `wght=800` and `wdth=75`, then with its axes dropped back to
the defaults. `TRAK.ttf` follows HarfBuzz's upstream golden at `ptem=9`, then
unsets ptem and must move `ABC` from advances `1060,1060,1060` to
`1000,1000,1000`. Only `xAdvance` may change in either pair.
