# 120 — Same-machine Chromium text parity contract

## Normative requirement

When Chromium and Domotion run on the same machine with the same browser build
and configuration, OS/image and architecture, installed fonts, locale and font
preferences, captured resources, CSS inputs, device scale, zoom, and writing
mode, Domotion **must produce the same logical text result as Chromium**.

Logical equality means, for every shaped cluster:

- the same concrete font file and collection member, PostScript face/cut, and
  variation-axis instance (including the same terminal fallback donor);
- the same glyph sequence, cluster mapping, advances, and offsets; and
- equivalent fallback boundaries, line breaks, baselines, and inline layout.

A different face or glyph sequence is a conformance failure even when its pixels
happen to score better. Pixel equality is not the logical oracle: after logical
equality is established, minor differences caused solely by rasterization,
hinting, or antialiasing are accepted and must be labeled as such.

This is a **same-machine** contract. Two hosts with different font inventories
or preferences may legitimately choose different faces. Each host must agree
with Chromium running in that exact environment; cross-machine face equality is
not required.

## Verdicts

Every font, shaping, or layout gate must issue one of these verdict classes for
each input. It must not collapse them into a pixel percentage:

1. **`exact-logical-agreement`** — face instance, glyph/cluster data, metrics,
   fallback boundaries, and layout agree. Pixel equality may additionally pass.
2. **`accepted-rasterization-only`** — logical output is already proven equal;
   the remaining bounded difference is attributable only to documented
   rasterization, hinting, or antialiasing.
3. **`explicit-unsupported`** — the input matches an enumerated unsupported
   feature, was detected before approximation, and produced an actionable
   diagnostic naming the feature and remediation or fallback. Silent
   approximation is a failure, not this verdict.

Anything else is a logical mismatch and fails. Allowlisting may record known
work, but cannot relabel a mismatch as rasterization-only.

## Environment fingerprint

A comparable report records, and a baseline gate refuses comparison when any
applicable value changes:

- launched Chromium version/revision and relevant launch flags;
- OS image/version, architecture, and installed-font inventory digest;
- locale, language preferences, and generic-family preference resolution;
- native helper implementation/build-recipe version and whether each resolver
  path was enabled (locally built executable bytes are not a stable version: PE
  timestamps and build IDs may differ across otherwise identical builds);
- Node ICU and Unicode versions, HarfBuzz build/revision, the Chromium checkout
  revision, and Chromium-pinned Skia revision used for transcriptions;
- device scale factor, page zoom, writing mode, and text direction; and
- corpus identity, webfont/resource identity, oracle cache/document isolation,
  and sample/shard identity.

Unknown values are recorded explicitly. A missing field does not prove
comparability; new baselines must contain the complete fingerprint. Reports
from different environments may be useful diagnostics but cannot be compared
as regressions.

## Gate structure

Face selection, shaping, layout, and pixels are ordered gates:

1. **Face selection** compares the concrete file/member/PostScript name, axes,
   and terminal donor.
2. **Shaping** compares glyph IDs, clusters, advances, offsets, direction, and
   fallback-run boundaries.
3. **Layout** compares line breaks, inline positions, and baselines.
4. **Pixels** run only after 1–3 agree, and can therefore distinguish exact
   pixels from an accepted rasterization-only difference.

The existing font-conformance oracle ([doc 107](107-font-conformance-oracle.md))
is the face-selection instrument. Cluster, layout, and visual instruments must
report their own stage; a visual score can never override an earlier failure.

Every native helper or oracle route used by a gate needs a negative control:
disable that route and require at least one declared discriminator to move. An
unchanged answer means the mechanism was not proven to be in the loop and the
gate verdict is withheld. Controls use the production switches (currently
`DOMOTION_DISABLE_HELPER=1` and, where applicable,
`DOMOTION_SYSTEM_FALLBACK=0`) and record both arms in the report.

Routine CI uses deterministic, representative 5–10 minute samples on macOS,
Linux, and Windows. Low-byte buckets `00` through `FF` are disjoint and together
cover every scalar value; stack/style/locale buckets rotate alongside them and
record the bucket at each revision. Samples include generic and named families,
missing-first stacks, webfonts and `unicode-range`, weight/style/stretch and
variable instances, emoji/text presentation, CJK locales, RTL, and combining
scripts. macOS remains the primary development platform, while all three OSes
enforce the same contract. Exhaustive products are confidence/release gates,
not routine per-change work.
