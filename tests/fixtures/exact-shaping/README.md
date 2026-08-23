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

DM-2532 adds three more byte-for-byte fixtures from HarfBuzz revision
`4de187dd0a915d13c976fa8bd474c084229f3aab`:

- `ArabicRligTest.ttf.base64` is upstream
  `a919b33197965846f21074b24e30250d67277bce.ttf`, Git blob
  `d2f116efa2606c2b55314df53a15223f0857f0f7`, SHA-256
  `9d9e6025284c0833926775248918ec1fa9b2417fde90abaa663cc9b625e3bdb1`;
- `ArabicMarkTest.ttf.base64` is upstream
  `1af868501dfcfd16184116b966f7fb2bd310623c.ttf`, Git blob
  `f450682fdf35bd9317a79a85867fd937361c1f57`, SHA-256
  `6aeee1f0d98fe4b6b5a7eb99324a2a27549133b2f0ee64a53357c391217767d9`;
- `LOCLTest.ttf.base64` is upstream
  `6991b13ce889466be6de3f66e891de2bc0f117ee.ttf`, Git blob
  `d98496683c503a9ee00806af6ed47c4c06d7674b`, SHA-256
  `8440df3446a0724e2498ba62980d55ad0b0ad5e568cdc0ad4efd85c7f8d4b455`.

These are HarfBuzz in-house test fixtures, but their font bytes are not
relabelled with HarfBuzz's source-code license. IranNastaliq has no embedded
copyright or license string; the tiny ProbeMid mark-attachment fixture also
has no embedded copyright/license string; LOCLTest carries an Adobe copyright
and no embedded license string. The oracle preserves this exact status in its
fixture evidence. All three files are used only for deterministic logical
shaping; they are never installed and are not raster-graded.
